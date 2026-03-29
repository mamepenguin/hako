import { Command } from "commander";
import { Hako, fetchPage } from "hako-db";
import type { Entry, SearchResult } from "hako-db";

const program = new Command();

program
  .name("hako")
  .description("Hako: data store with hybrid search")
  .version("0.1.0");

program
  .command("add")
  .description("Add an entry")
  .requiredOption("--title <title>", "Entry title")
  .option("--content <content>", "Entry content or excerpt")
  .option("--source <source>", "Data source identifier (e.g. web, email, craft)", "")
  .option("--url <url>", "Related URL")
  .option("--tags <tags>", "Comma-separated tags", "")
  .option("--happened-at <date>", "When it happened (ISO 8601)")
  .action(async (opts) => {
    const hako = new Hako();
    try {
      const result = await hako.save({
        title: opts.title,
        content: opts.content ?? null,
        source: opts.source,
        url: opts.url ?? null,
        tags: opts.tags,
        happened_at: opts.happenedAt ?? null,
      });
      console.log(`${result.status}: id=${result.id} ${opts.title}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    } finally {
      hako.close();
    }
  });

program
  .command("search <query>")
  .description("Search entries with hybrid search")
  .option("--source <source>", "Filter by source")
  .option("--limit <n>", "Max results", "10")
  .action(async (query: string, opts) => {
    const hako = new Hako();
    try {
      const results = await hako.search(query, {
        source: opts.source,
        limit: parseInt(opts.limit, 10),
      });
      if (results.length === 0) {
        console.log("No results found.");
        return;
      }
      for (const r of results) {
        printEntrySummary(r);
      }
    } finally {
      hako.close();
    }
  });

program
  .command("list")
  .description("List entries chronologically")
  .option("--source <source>", "Filter by source")
  .option("--since <date>", "From date (ISO 8601)")
  .option("--until <date>", "To date (ISO 8601)")
  .option("--limit <n>", "Max results", "20")
  .action((opts) => {
    const hako = new Hako();
    try {
      const entries = hako.list({
        source: opts.source,
        since: opts.since,
        until: opts.until,
        limit: parseInt(opts.limit, 10),
      });
      if (entries.length === 0) {
        console.log("No entries found.");
        return;
      }
      for (const e of entries) {
        printEntrySummary(e);
      }
    } finally {
      hako.close();
    }
  });

program
  .command("show <id>")
  .description("Show entry details")
  .action((id: string) => {
    const hako = new Hako();
    try {
      const entry = hako.get(parseInt(id, 10));
      if (!entry) {
        console.log(`Entry ${id} not found.`);
        return;
      }
      printEntryDetail(entry);
    } finally {
      hako.close();
    }
  });

program
  .command("delete <id>")
  .description("Delete an entry")
  .option("-y, --yes", "Skip confirmation")
  .action(async (id: string, opts) => {
    const entryId = parseInt(id, 10);

    if (!opts.yes) {
      const readline = await import("node:readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question(
          "Are you sure you want to delete this entry? (y/N) ",
          resolve,
        );
      });
      rl.close();
      if (answer.toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    }

    const hako = new Hako();
    try {
      if (hako.delete(entryId)) {
        console.log(`Deleted entry ${id}.`);
      } else {
        console.log(`Entry ${id} not found.`);
      }
    } finally {
      hako.close();
    }
  });

program
  .command("sources")
  .description("List known data sources")
  .action(() => {
    const hako = new Hako();
    try {
      const sources = hako.sources();
      if (sources.length === 0) {
        console.log("No sources found.");
        return;
      }
      for (const s of sources) {
        console.log(`  ${s.source}: ${s.count}`);
      }
    } finally {
      hako.close();
    }
  });

program
  .command("stats")
  .description("Show database statistics")
  .action(() => {
    const hako = new Hako();
    try {
      const s = hako.stats();
      console.log(`Total entries: ${s.total_entries}`);
      console.log(`DB size: ${s.db_size_mb} MB`);
      if (s.sources.length > 0) {
        console.log("\nBy source:");
        for (const src of s.sources) {
          console.log(`  ${src.source}: ${src.count}`);
        }
      }
    } finally {
      hako.close();
    }
  });

program
  .command("web <url>")
  .description("Fetch a web page and save it")
  .option("--title <title>", "Override page title")
  .option("--content <content>", "Override content")
  .option("--tags <tags>", "Comma-separated tags", "")
  .option("--happened-at <date>", "When you saw it (ISO 8601)")
  .action(async (url: string, opts) => {
    const hako = new Hako();
    try {
      let title = opts.title ?? "";
      let content = opts.content ?? null;

      try {
        console.log(`Fetching ${url} ...`);
        const page = await fetchPage(url);
        if (!title) title = page.title;
        if (content === null) content = page.content;
        url = page.url;
      } catch (err) {
        console.error(`Fetch failed: ${(err as Error).message}`);
        if (!title) title = url;
      }

      const result = await hako.save({
        title,
        content,
        source: "web",
        url,
        tags: opts.tags,
        happened_at: opts.happenedAt ?? null,
      });
      console.log(`${result.status}: id=${result.id} ${title}`);
    } finally {
      hako.close();
    }
  });

function printEntrySummary(entry: Entry | SearchResult): void {
  const score = "score" in entry ? ` [${(entry as SearchResult).score.toFixed(4)}]` : "";
  const source = entry.source ? ` (${entry.source})` : "";
  console.log(`  [${entry.id}]${source} ${entry.title}${score}`);
  if (entry.url) {
    console.log(`       ${entry.url}`);
  }
  console.log(`       ${entry.happened_at}`);
}

function printEntryDetail(entry: Entry): void {
  console.log(`ID:          ${entry.id}`);
  console.log(`Title:       ${entry.title}`);
  console.log(`Source:      ${entry.source || "(none)"}`);
  if (entry.url) {
    console.log(`URL:         ${entry.url}`);
  }
  console.log(`Happened at: ${entry.happened_at}`);
  console.log(`Created at:  ${entry.created_at}`);
  console.log(`Tags:        ${entry.tags || "(none)"}`);
  console.log(`Accessed:    ${entry.access_count} times`);
  if (entry.content) {
    console.log(`\n${entry.content}`);
  }
}

program.parseAsync(process.argv);
