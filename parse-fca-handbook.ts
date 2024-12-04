import { readFileSync } from "fs"
import * as cheerio from "cheerio";
import { pullThroughCache, pullThroughFetchText, turndownService } from "./utils.js";
import { ParsedNode, ParsedNodeWithChildren } from "./types.js";
import slugify from "slugify";
import { getArticlesContainer, getDocumentsContainer, saveArticle, saveDocument } from "./cosmos.js";
import { AnyNode, Element } from "domhandler";
import { Container } from "@azure/cosmos";

function absoluteUrl(url?: string) {
  if (!url) {
    return "";
  }
  if (!url.startsWith("https")) {
    if (url.startsWith("/")) {
      return "https://www.handbook.fca.org.uk" + url;
    }
  }
  return url;
}

export type CheerioElement = cheerio.Cheerio<Element>;

async function processTocNode(node: CheerioElement, $: cheerio.CheerioAPI, parent: ParsedNodeWithChildren, tocData: ParsedNodeWithChildren, parentCollectionCodes: string[], index: number) {

  const forceCode = parentCollectionCodes[index] ?? "";
  const entryLink = $("> a", node);
  const entryHref = absoluteUrl(entryLink.attr("href"));
  const entryTitle = entryLink.text().trim();
  const entryTitleAttribute = entryLink.attr("title")?.replace("Contains - ", "") ?? "";
  const children = $("> ul > li", node);
  const childCodes = entryTitleAttribute.split(", ").map(s => s.trim());
  const entryCode = forceCode ? `${tocData.code}-${forceCode}` : `${tocData.code}-${slugify(entryTitle)}`;
  const entryType = children.length ? "collection" : "document";
  // console.log("entryCode", entryCode);
  const entry: ParsedNodeWithChildren = {
    original: {},
    jurisdiction: "GB",
    regulators: [
      { code: "GB-FCA", title: "FCA" },
    ],
    metadata: {
      sourceUrl: entryHref,
    },
    code: entryCode,
    citation: "",
    parents: [...parent.parents, { code: parent.code, title: parent.title, type: parent.type }],
    type: entryType,
    title: entryTitle,
    markdown: "",
    text: "",
    children: [],
  };
  addCode(entryCode, entry);
  parent.children.push(entry);
  if (entryType === "collection") {
    let childIndex = 0;
    for (const child of children) {
      await processTocNode($(child), $, entry, tocData, childCodes, childIndex);
      childIndex += 1;
    }
  } else if (entryType === "document") {
    await processDocument(entry, node, parent, tocData)
  }
  return entry;
}

const SKIPPED: string[] = [];
function skip(msg: string) {
  SKIPPED.push(msg);
}

async function processDocument(entry: ParsedNodeWithChildren, child: CheerioElement, parent: ParsedNodeWithChildren, tocData: ParsedNodeWithChildren) {
  // console.log(entry.title);
  process.stdout.write(".");
  const { children, ...rest } = entry;
  const doc: ParsedNode = rest;
  // collect article html from page
  const html = await collectArticleHtml(doc.metadata.sourceUrl as string);
  const $ = cheerio.load(html);
  let currentSection = entry;
  let currentSectionIndex = 0;
  let semanticSectionIndex = 0;
  const articleEl = $('article');
  const sections = collectDocumentSectionsAsEl(entry, articleEl, $);
  if (!sections.length) {
    if (isDeleted(entry, articleEl)) {
      return;
    }
    console.log(`SKIPPING ${entry.code}`);
    skip(entry.code);
    // throw new Error("Could not find any sections");
    return;
  }
  async function walkSection() {
    const section = $(sections.get(currentSectionIndex));
    if (!section.length) {
      return;
    }
    if (isSection(section)) {
      semanticSectionIndex++;
      const title = getSectionTitle(section, $);
      // console.log("isSection", title);
      const nextSection = {
        original: {},
        jurisdiction: "GB",
        regulators: entry.regulators,
        metadata: {},
        code: `${entry.code}-section-${semanticSectionIndex}`,
        citation: "",
        parents: [...currentSection.parents],
        type: "section",
        title: title,
        markdown: "",
        text: "",
        children: [],
      };
      entry.children.push(nextSection);
      currentSection = nextSection;
      addCode(currentSection.code, currentSection);
    } else if (isArticle(section)) {

      
      const currentArticleEl = section;
      const cleanArticleEl = getCleanArticleElement(currentArticleEl, $);
      const html = getArticleHtml(cleanArticleEl, $);
      // const text = currentArticleEl.text().trim();
      const text = getArticleText(cleanArticleEl, $);
      // Ignore if there's no content
      if (html && text) {

        // console.log("IS ARTICLE");
        const coreArticleCode = getCoreArticleCode(currentSection, section, $, tocData);
        if (!coreArticleCode || coreArticleCode.trim() === "") {
          skip("COULDNT FIND CODE: " + entry.metadata.sourceUrl);
        }
        const fullArticleCode = `${entry.code}-${coreArticleCode}`
        // console.log(articleCode);
        const article: ParsedNode = {
          original: {},
          jurisdiction: "GB",
          regulators: entry.regulators,
          metadata: {},
          code: fullArticleCode,
          citation: "",
          parents: [...currentSection.parents, { code: currentSection.code, title: currentSection.title, type: currentSection.type }],
          type: "article",
          title: `${getSectionTitle(section, $)} ${coreArticleCode}`.trim(),
          markdown: "",
          text: "",
        };

        // PUT ARTICLE IN SECTION
        const articleForDocument: ParsedNodeWithChildren = {
          ...article,
          children: [],
        };
        currentSection.children.push(articleForDocument);

        // STORE ARTICLE AS ARTICLE, WITH TEXT
        try {
          const markdown = turndownService.turndown(html);
          article.markdown = markdown;
          article.text = text;
        } catch (e) {
          console.error(`Markdown error for ${entry.metadata.sourceUrl}`);
          console.error(html);
          throw e;
        }
        addCode(article.code, article);

        if (Math.random() > 0.999) {
          await saveArticle(article);
        }

        // if (Math.random() > 0.999) {
        //   console.log("-----")
        //   console.log(article.code);
        //   console.log(article.title);
        //   console.log(article.text.slice(0,1000));
        //   console.log("-----")
        // }
      }

    } else {
      console.error(section.html())
      throw new Error("Could not identify piece");
    }
    currentSectionIndex++;
    await walkSection();
  }
  await walkSection();
  // now we can save the Document, which contains Sections + ArticlesWithNoContent
  if (Math.random() > 0.999) {
    await saveDocument(entry);
  }
  // throw new Error("STOP");
}

const allCodes = new Map<string, unknown>();
function addCode(code: string, thing: unknown) {
  if (allCodes.has(code)) {
    // console.error("----DUPLICATE CODE ... existing thing:");
    // console.error(allCodes.get(code));
    const existing = allCodes.get(code);
    const thingText = (thing as any).text ?? "NO TEXT";
    const existingText = (existing as any).text ?? "NO TEXT";
    if (thingText !== existingText) {
      (thing as any).code += `-additional`;
      // console.error((thing as any).code);
      addCode((thing as any).code, thing);
    } else {
      throw new Error(`DUPLICATE CODE ${code}`)
    }
  }
  allCodes.set(code, thing);
}

function getCleanArticleElement(originalEl: CheerioElement, $: cheerio.CheerioAPI) {
  const el = originalEl.clone();
  el.find(".level.rule.deleted").remove();
  el.find(".details").remove();
  el.find(".rule a.changed-by").remove();
  el.find(".guidance a.changed-by").remove();
  el.find('section > div.level.deleted').remove();
  el.find('a').each((index, a) => {
    const $a = $(a);
    const href = $a.attr('href');
    if (href && href.startsWith("/")) {
      $a.attr("href", `https://www.handbook.fca.org.uk${href}`);
    }
  });
  el.find("table").each((i, table) => {
    const $table = $(table);
    if ($table.text().trim() === "") {
      $table.remove();
    }
  });
  return el;
}

function getArticleHtml(el: CheerioElement, $: cheerio.CheerioAPI) {
  return el.html()?.replaceAll('•', '') ?? null;
}

function getArticleText(el: CheerioElement, $: cheerio.CheerioAPI) {
  return el.text().replaceAll('•', '').trim();
}

function collectDocumentSectionsAsEl(entry: ParsedNodeWithChildren, articleEl: CheerioElement, $: cheerio.CheerioAPI) {
  const sections = articleEl.find("section");
  if (sections.length) {
    return sections;
  }
  const tables = articleEl.find("table");
  if (tables.length) {
    tables.wrap(`<div class="table-wrapper"></div>`);
    return tables.parent();
  }
  if (isDeleted(entry, articleEl)) {
    return articleEl.find("DEFINITELYNOT");
  }
  const articleContentEl = isOneBigArticle(entry, articleEl)
  if (articleContentEl) {
    // console.log("TREATING AS ONE BIG ARTICLE", entry.metadata.sourceUrl);
    return articleContentEl;
  }
  return articleEl.find("DEFINITELYNOT");
}
let stopcounter = 0;
const ARTICLE_MAX = 50000;

function isOneBigArticle(entry: ParsedNodeWithChildren, articleEl: CheerioElement) {
  if (entry.metadata.sourceUrl === "https://www.handbook.fca.org.uk/handbook/glossary/") {
    return false;
  }
  const articleClone = articleEl.clone();
  articleClone.find("header").remove();
  articleClone.find(".details").remove();
  const articleText = articleClone.text();
  if (articleText.length < ARTICLE_MAX) {

    return articleClone.wrap("<section></section>").parent();
  }
}

function getCoreArticleCode(currentSection: ParsedNodeWithChildren, el: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI, tocData: ParsedNodeWithChildren) {
  const extendedEl = $(".extended", el);
  let code = '';
  if (extendedEl) {
    const text = extendedEl.text().trim();
    if (text) {
      code = slugify(text);
    }
  }
  if (!code) {
    code = `article-${currentSection.children.length + 1}`;
  }
  
  if (allCodes.has(code)) {
    console.error("----DUPLICATE ARTICLE CODE ", code);
    // console.error(allCodes.get(code));
    code += "-additional";
    console.error(code);
  }
  return code;
}

function getSectionTitle(el: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI) {
  return $("header", el).text().trim();
}
function isSection(el: cheerio.Cheerio<Element>) {
  const headerEl = el.find("header");
  if (headerEl.length) {
    if (el.text().trim() && el.text().trim() === headerEl.text().trim()) {
      return true;
    }
  }
}
function isTitle(el: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI) {
  return el.prop("tagName") === "header";
}
function isDeleted(entry: ParsedNodeWithChildren, documentEl: CheerioElement) {
  const title = entry.title.toLowerCase();
  if (title.indexOf("deleted") !== -1) return true;
  if (title.indexOf("expired") !== -1) return true;
  const text = documentEl.text().trim().toLowerCase();
  if (text.indexOf("deleted") !== -1) return true;
  return false;
}


function isArticle(el: cheerio.Cheerio<Element>) {
  const TAGNAME = el.prop('tagName');
  if (!TAGNAME) {
    console.error(el);
    throw new Error("no tagname");
  }
  const tagname = TAGNAME.toLowerCase();
  if (tagname === "section") return true;
  if (tagname === "table") return true;
  if (el.hasClass('table-wrapper')) return true;
  return false;
}

async function collectArticleHtml(href: string) {
  return pullThroughFetchText(href);
}


async function getToc() {
  return pullThroughCache(`fca-handbook-toc.json`, async() => {
    const tocData: ParsedNodeWithChildren = {
      original: {},
      jurisdiction: "GB",
      regulators: [
        { code: "GB-FCA", title: "FCA" },
      ],
      metadata: {
        sourceUrl: "https://www.handbook.fca.org.uk/handbook",
      },
      code: "GB-FCA-FCA-handbook",
      citation: "",
      parents: [],
      type: "collection",
      title: "FCA Handbook",
      markdown: "",
      text: "",
      children: [],
    };
    const rawHtml = await pullThroughFetchText("https://www.handbook.fca.org.uk/handbook");
    const $ = cheerio.load(rawHtml);
    const toc = $(".toc .toc .toc");
    const collections = $("ol.publications-nav > li", toc);
    let count = 0;
    for (const collection of collections) {
      await processTocNode($(collection), $, tocData, tocData, [], count);
      count += 1;
    }
    return tocData;
  }, true);
}





/*********************************************
 * RUN
**********************************************/


await clearDocuments();

const toc = await getToc();

console.log("SKIPPED:");
SKIPPED.forEach((str) => {
  console.log(" - ", str);
});

function printToc(entry: ParsedNodeWithChildren) {
  console.log(entry.code);
  for (const child of entry.children) {
    printToc(child);
  }
}

async function clearDocuments() {
  const docsContainer = await getDocumentsContainer();
  await deleteResources(docsContainer, "SELECT * FROM c WHERE c.jurisdiction = 'GB'");
  const articlesContainer = await getArticlesContainer();
  await deleteResources(articlesContainer, "SELECT * FROM c WHERE c.jurisdiction = 'GB'");
}
async function deleteResources(container: Container, query: string) {
  const {resources} = await container.items.query(query).fetchAll();
  for (const item of resources) {
    await container.item(item.id, item.code).delete();
  }
}