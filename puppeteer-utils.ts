import { Browser, Page, executablePath } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// On top of your code
const cache: Record<
  string,
  {
    status: number;
    headers: Record<string, string>;
    body: Buffer;
    expires: number;
  }
> = {};

let browser: Browser;
export async function setupPuppeteer() {
  puppeteer.use(StealthPlugin());
  browser = await puppeteer.launch({
    headless: true,
    executablePath: executablePath(),
  });
}

export async function closePuppeteer() {
  await browser.close();
}
// The code below should go between newPage function and goto function
export async function getPage() {
  const page = await browser.newPage();
  // await page.setRequestInterception(true);

  // page.on("request", async (request) => {
  //   const url = request.url();
  //   if (cache[url] && cache[url].expires > Date.now()) {
  //     await request.respond(cache[url]);
  //     return;
  //   }
  //   request.continue();
  // });

  // page.on("response", async (response) => {
  //   const url = response.url();
  //   const headers = response.headers();
  //   const cacheControl = headers["cache-control"] || "";
  //   const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
  //   const maxAge =
  //     maxAgeMatch && maxAgeMatch.length > 1 ? parseInt(maxAgeMatch[1], 10) : 0;
  //   if (maxAge) {
  //     if (cache[url] && cache[url].expires > Date.now()) return;

  //     let buffer;
  //     try {
  //       buffer = await response.buffer();
  //     } catch (error) {
  //       // some responses do not contain buffer and do not need to be catched
  //       return;
  //     }

  //     cache[url] = {
  //       status: response.status(),
  //       headers: response.headers(),
  //       body: buffer,
  //       expires: Date.now() + maxAge * 1000,
  //     };
  //   }
  // });
  return page;
}
