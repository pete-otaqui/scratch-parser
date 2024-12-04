import { pullThroughFetchText } from "./utils.js";

import hrefs from "./fca-hrefs.json";

async function getFCAHandbookHref(href: string) {
  const html = pullThroughFetchText(href);
  return html;
}

async function main() {
  const batchSize = 20;
  const total = hrefs.length;
  const numberOfBatches = Math.ceil(total / batchSize);
  console.log(`Going to fetch ${total} documents in ${numberOfBatches} batches of ${batchSize}`);
  for (let i = 0; i < hrefs.length; i += batchSize) {
    const batch = hrefs.slice(i, i + batchSize);
    const promises = batch.map(getFCAHandbookHref);
    await Promise.all(promises);
    process.stdout.write(".");
    if (i + 1 % 100 === 0) {
      console.log("");
    }
  }
}

main();
