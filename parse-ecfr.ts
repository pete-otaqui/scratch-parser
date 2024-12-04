import * as cheerio from "cheerio";
import { convert as convertHtmlToText } from "html-to-text";
import slugify from "slugify";

import { saveArticle, saveDocument } from "./cosmos.js";
import { closePuppeteer, setupPuppeteer } from "./puppeteer-utils.js";
import title12 from "./title-12.json";
import title17 from "./title-17.json";
import { Node, ParsedNode, ParsedNodeWithChildren } from "./types.js";
import {
  Cache,
  convertHtmlToTextOptions,
  pullThroughGetText,
  setAbsoluteBase,
  turndownService,
} from "./utils.js";

function getNodeType(node: ParsedNode, children: Node[]) {
  switch (node.type) {
    case "title":
    case "chapter":
    case "subchapter":
      return "collection";
    case "part":
      return "document";
    case "subpart":
    case "subject_group":
      return "section";
    case "section":
      return "article";
    default:
      if (!children || !children.length) {
        return "article";
      }
      console.log(node);
      throw new Error(`Unknown type ${node.type}`);
  }
}

async function collectHtml(
  node: ParsedNode,
  overrideUrl?: string,
): Promise<string> {
  const url =
    overrideUrl ??
    `https://www.ecfr.gov/current/${node.metadata.fullPath.replaceAll("_", "-")}`;
  const allHtml = await pullThroughGetText(url);
  const $ = cheerio.load(allHtml);
  const selectors = getArticleSelectors(node);
  for (let selector of selectors) {
    const html = $(selector).html();
    if (html) {
      return html;
    }
  }
  if (
    $.text().indexOf("The content you requested is no longer in the eCFR") !==
    -1
  ) {
    return "Removed";
  }
  // Sometimes they fuck up their own links ...
  // "https://www.ecfr.gov/current/title-12/chapter-I/part-19/subpart-E through G"
  // actually has a URL of:
  // "https://www.ecfr.gov/current/title-12/chapter-I/part-19/subpart-E"
  // with the stuff after the first space stripped off.
  if (!overrideUrl) {
    if (url.indexOf(" ") !== -1) {
      return collectHtml(node, url.split(" ")[0]);
    }
  }
  // OK, legit couldn't work this out - log an error
  console.error(
    `Could not find HTML for ${url} with selectors: ${selectors.join(",")}`,
  );
  return "";
}

function getNodePath(node: ParsedNode) {
  return `${node.type}-${node.original.identifier}`;
}

function joinNodePaths(nodes: ParsedNode[]) {
  return nodes.map((node) => node.metadata.path).join("/");
}

function parseHtmlToMarkdown(html: string) {
  const markdown = turndownService.turndown(html);
  return markdown;
}

function getArticleSelectors(node: ParsedNode) {
  if (!node.original.identifier) {
    console.log(node);
    throw new Error(`Node has no identifier`);
  }
  const safeIdentifier = node.original.identifier.replaceAll(" ", "-");
  return [
    `[id=${safeIdentifier}]`,
    `[id=${node.original.type}-${safeIdentifier}]`,
  ];
}

function getNodeTitle(node: Node) {
  const hasIdentifier = node.identifier && node.identifier.length;
  if (hasIdentifier) {
    return `${node.identifier} ${node.label_description}`;
  }
  return node.label_description;
}

async function parseNode(
  node: Node,
  parents: ParsedNode[] = [],
  allNodes: Set<ParsedNode> = new Set(),
) {
  const children = node.children;

  if (node.type === "hed1") {
    return allNodes;
  }
  const clonedNode: ParsedNode = {
    citation: "",
    jurisdiction: "US",
    regulators: [
      {
        code: "us-federal-government",
        title: "US Federal Government",
      },
    ],
    parents: parents.map(({ code, title, type }) => ({ code, title, type })),
    title: getNodeTitle(node),
    original: {
      identifier: node.identifier,
      label: node.label,
      label_level: node.label_level,
      label_description: node.label_description,
      reserved: node.reserved,
      type: node.type,
    },
    type: node.type,
    metadata: {
      path: "",
      fullPath: "",
    },
    code: "",
    markdown: "",
    text: "",
  };
  // const clonedNode = { ...node };
  // delete clonedNode.children;
  const nextParents = [...parents, clonedNode];

  clonedNode.metadata.path = getNodePath(clonedNode);
  clonedNode.type = getNodeType(clonedNode, children);
  // clonedNode.parentPaths = parents.map((parent) => joinNodePaths(parent));
  const fullPath = joinNodePaths(nextParents);
  clonedNode.metadata.fullPath = fullPath;
  clonedNode.code = "us-cfr-" + slugify(fullPath.replaceAll("/", "-"));
  const isArticle = clonedNode.type === "article";
  const prefix = isArticle ? " " : "+";
  // console.log(prefix, clonedNode.code);
  if (children && children.length) {
    for (let child of children) {
      await parseNode(child, nextParents, allNodes);
    }
  }
  allNodes.add(clonedNode);
  return allNodes;
}

async function processDocument(root: ParsedNodeWithChildren) {
  const cachePath = `exported/001-document-${slugify(root.code)}.json`;
  Cache.store(cachePath, root);
}

async function processArticles(nodes: ParsedNode[]) {
  const batchSize = 10;
  console.log(
    `will process ${nodes.length} articles in ${Math.ceil(nodes.length / batchSize)} batches of ${batchSize}`,
  );
  let step = 0;
  for (let i = 0; i < nodes.length; i += batchSize) {
    const batch = nodes.slice(i, i + batchSize);
    await Promise.all(batch.map(processArticle));
    process.stdout.write(".");
    if (++step % 100 === 0) {
      console.log("");
    }
  }
  console.log("");
}

async function processArticle(node: ParsedNode) {
  const cachePath = `exported/${slugify(node.code)}.json`;
  let existing: ParsedNode | null = await Cache.get(cachePath);
  if (!existing) {
    const html = await collectHtml(node);
    // node.html = targetedHtml;
    node.text = convertHtmlToText(html, convertHtmlToTextOptions);
    let markdown = parseHtmlToMarkdown(html);
    if (!markdown) {
      console.error(`Could not create markdown for ${node.code}`);
      markdown = "";
    }
    node.markdown = markdown;
    Cache.store(cachePath, node);
    existing = node;
  }
  await saveArticle(existing);
}

function recursivelyConstructDocument(
  node: ParsedNode,
  allNodes: ParsedNode[],
): ParsedNodeWithChildren {
  const myChildren = allNodes.filter(
    (child) =>
      child.parents.length &&
      child.parents[child.parents.length - 1].code === node.code,
  );
  const clone: ParsedNodeWithChildren = {
    ...node,
    children: [],
  };
  for (let child of myChildren) {
    const clonedChild = recursivelyConstructDocument(child, allNodes);
    if (clonedChild.type === "article") {
      const { text, markdown, ...safeClonedChild } = clonedChild;
      clone.children.push({
        ...safeClonedChild,
        text: "",
        markdown: "",
        children: [],
      });
    } else {
      clone.children.push(clonedChild);
    }
  }
  return clone;
}

async function processDocuments(
  documents: ParsedNode[],
  allNodes: ParsedNode[],
) {
  const batchSize = 10;
  console.log(
    `will process ${documents.length} documents in ${Math.ceil(
      documents.length / batchSize,
    )} batches of ${batchSize}`,
  );
  let step = 0;
  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (doc) => {
        const root = recursivelyConstructDocument(doc, allNodes);
        await processDocument(root);
        await saveDocument(root);
      }),
    );
    process.stdout.write(".");
    if (++step % 100 === 0) {
      console.log("");
    }
  }
  console.log("");
}

async function processCollection(root: ParsedNodeWithChildren) {
  const cachePath = `exported/000-collection-${slugify(root.code)}.json`;
  Cache.store(cachePath, root);
}
async function processCollections(allNodes: ParsedNode[]) {
  const collections = allNodes.filter((node) => node.type === "collection");
  console.log("FOUND", collections.length, "collections");
  function recursivelyConstructCollection(collection: ParsedNode) {
    const myChildren = allNodes.filter(
      (child) =>
        child.parents.length &&
        child.parents[child.parents.length - 1].code === collection.code,
    );
    const clone: ParsedNodeWithChildren = {
      ...collection,
      children: [],
    };
    for (let child of myChildren) {
      const clonedChild = recursivelyConstructCollection(child);
      if (clonedChild.type === "document") {
        const { text, markdown, ...safeClonedChild } = clonedChild;
        clone.children.push({
          ...safeClonedChild,
          text: "",
          markdown: "",
          children: [],
        });
      } else {
        clone.children.push(clonedChild);
      }
    }
    return clone;
  }
  for (let collection of collections) {
    const root = recursivelyConstructCollection(collection);
    await processCollection(root);
    await saveDocument(root);
  }
}

async function processTitle(titleData: Node) {
  console.log("processing title", titleData.label);
  const allNodesSet = await parseNode(titleData);
  console.log("FOUND", allNodesSet.size, "nodes");
  const allNodesArray = Array.from(allNodesSet);
  const documents = allNodesArray.filter((node) => node.type === "document");
  if (!documents.length) {
    throw new Error("Could not find documents");
  }
  await processCollections(allNodesArray);
  await processDocuments(documents, allNodesArray);
  const articleNodes = allNodesArray.filter((node) => node.type === "article");
  console.log("FOUND", articleNodes.length, "articles");
  await setupPuppeteer();
  await processArticles(articleNodes);
  await closePuppeteer();
}

async function main() {
  setAbsoluteBase("https://www.ecfr.gov");
  await processTitle(title12 as Node);
  await processTitle(title17 as Node);
}

main();
