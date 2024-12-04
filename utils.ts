import fs from "fs";

import * as cheerio from "cheerio";
import {
  convert as convertHtmlToText,
  DomNode,
  HtmlToTextOptions,
} from "html-to-text";
import slugify from "slugify";
import TurndownService from "turndown";
// @ts-expect-error
import { tables } from "turndown-plugin-gfm";
import { getPage } from "./puppeteer-utils.js";

export const turndownService = new TurndownService({});

let absoluteBase = "";

export function setAbsoluteBase(base: string) {
  absoluteBase = base;
}
turndownService.addRule("absoluteLinks", {
  filter: ["a"],
  replacement: function (content, node) {
    const href = (node as HTMLElement).getAttribute("href");
    if (href?.startsWith("http")) {
      return `[${content}](${href})`;
    }
    const newContent = `[${content}](${absoluteBase}${href})`;
    return newContent;
  },
});
turndownService.use(tables);

export const convertHtmlToTextOptions: HtmlToTextOptions = {
  wordwrap: 130,
};

export const Cache = {
  get<T>(key: string) {
    try {
      const data = fs.readFileSync(`./.cache/${key}`).toString();
      return JSON.parse(data) as T;
    } catch (e) {
      return null;
    }
  },
  store(key: string, data: unknown) {
    fs.writeFileSync(`./.cache/${key}`, JSON.stringify(data, null, 2));
  },
};

export async function pullThroughCache<T>(
  key: string,
  getter: () => Promise<T>,
  force = false,
): Promise<T> {
  if (!Cache.get(key) || force) {
    const data = await getter();
    Cache.store(key, data);
  }
  return Cache.get(key) as T;
}

export async function pullThroughGetText(url: string): Promise<string> {
  return await pullThroughCache<string>(`html/${slugify(url)}`, async () => {
    const page = await getPage();
    await page.goto(url);
    const content = await page.content();
    await page.close();
    return content;
  });
}

export async function pullThroughFetchText(url: string): Promise<string> {
  return await pullThroughCache<string>(`html/${slugify(url)}`, async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to get url ${url}`);
    }
    const text = await response.text();
    return text;
  });
}

export async function pullThroughGetJson<T>(url: string) {
  return await pullThroughCache<T>(`json/${slugify(url)}`, async () => {
    const response = await fetch(url);
    return await response.json();
  });
}
