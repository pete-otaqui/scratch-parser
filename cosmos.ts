import { CosmosClient, Database } from "@azure/cosmos";
import "dotenv/config";
import { ParsedNode, ParsedNodeWithChildren } from "./types.js";

const FORCE = true;

let client: CosmosClient;
export async function getClient() {
  if (!client) {
    const connectionString = process.env.AZURE_COSMOS_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error("AZURE_COSMOS_CONNECTION_STRING is required");
    }
    client = new CosmosClient(connectionString);
  }
  return client;
}

let database: Database;
export async function getDatabase() {
  if (!database) {
    const databaseName = process.env.AZURE_COSMOS_DATABASE;
    if (!databaseName) {
      throw new Error("AZURE_COSMOS_DATABASE is required");
    }
    const client = await getClient();
    database = client.database(databaseName);
  }
  return database;
}

export async function getContainer(name: string) {
  const database = await getDatabase();
  const container = database.container(name);
  return container;
}

export async function getDocumentsContainer() {
  return getContainer("documents");
}

export async function getArticlesContainer() {
  return getContainer("articles");
}

export async function saveDocument(document: ParsedNodeWithChildren) {
  return performWithBackoff(() => saveDocumentCore(document));
}
export async function saveDocumentCore(document: ParsedNodeWithChildren) {
  const container = await getDocumentsContainer();
  const { resources } = await container.items
    .query({
      query: `SELECT * FROM c WHERE c.code = @code`,
      parameters: [{ name: "@code", value: document.code }],
    })
    .fetchAll();
  const existing = resources.length === 1;

  if (FORCE || !existing) {
    for (let resource of resources) {
      try {
        await container.item(resource.id, resource.code).delete();
      } catch (e) {
        console.error("ERROR DELETING", resource.id, e);
      }
    }
    await container.items.create(document);
  }
}

export async function saveArticle(article: ParsedNode) {
  return performWithBackoff(() => saveArticleCore(article));
}
export async function saveArticleCore(article: ParsedNode) {
  const jsonString = JSON.stringify(article);
  if (jsonString.length >= 2000000) {
    console.error(article.code, "IS TOO LARGE");
    return;
  }
  const container = await getArticlesContainer();
  const result = await container.items
    .query({
      query: `SELECT * FROM c WHERE c.code = @code`,
      parameters: [{ name: "@code", value: article.code }],
    })
    .fetchAll();
  const existing = Boolean(result.resources.length === 1);
  if (FORCE || !existing) {
    // obviously with 0 this will do nothing,
    // but we want to make sure we delete duplicates :)
    for (let resource of result.resources) {
      try {
        await container.item(resource.id, resource.code).delete();
      } catch (e) {
        console.error("ERROR DELETING", resource.id, e);
      }
    }
  }
  if (FORCE || !existing) {
    await container.items.create(article);
  }
}

export async function performWithBackoff<T>(
  fn: () => Promise<T>,
  {
    maxAttempts = 5,
    retryError = () => true,
    calculateDelay = (attempt) => {
      const jitter = Math.random() * 1000;
      const exponential = Math.pow(attempt, 2) * 1000;
      return jitter + exponential;
    },
  }: {
    maxAttempts?: number;
    retryError?: (error: any) => boolean;
    calculateDelay?: (attempt: number) => number;
  } = {},
  attempt = 1,
) {
  try {
    return await fn();
  } catch (e) {
    if (retryError(e) && attempt < maxAttempts) {
      const delay = calculateDelay(attempt);
      console.log(`retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      await performWithBackoff(
        fn,
        {
          maxAttempts,
          retryError,
          calculateDelay,
        },
        attempt + 1,
      );
    } else {
      throw e;
    }
  }
}
