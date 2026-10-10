import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { embeddedCatalogs } from "../src/registry/catalog.ts";
import { CATALOG_CACHE_TTL_MS, CATALOG_KEYS, CatalogStore } from "../src/registry/catalog-store.ts";
import {
  DEFAULT_CATALOG_URLS,
  MAX_CATALOG_BYTES,
  refreshCatalogs,
  resolveSource,
} from "../src/registry/refresh.ts";
import codexClientJson from "../src/registry/catalog/codex_client_models.json";
import modelsJson from "../src/registry/catalog/models.json";
import { FakeKv, fakeHttp, refreshLayer, workerEnv } from "./support/registry-refresh.ts";

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  object: "model",
  created: 1,
  owned_by: "x",
  type: "x",
  ...extra,
});

const sections = [
  "claude",
  "gemini",
  "vertex",
  "aistudio",
  "codex-free",
  "codex-team",
  "codex-plus",
  "codex-pro",
  "kimi",
  "antigravity",
  "xai",
];

/** A valid catalog document whose claude section is `claudeIds` and which optionally carries a meta section. */
const catalogText = (claudeIds: string[], meta: string[] = []) =>
  JSON.stringify({
    ...Object.fromEntries(sections.map((section) => [section, [entry(`${section}-1`)]])),
    claude: claudeIds.map((id) => entry(id)),
    meta: meta.map((id) => entry(id)),
  });

const [MODELS_URL, MODELS_MIRROR] = DEFAULT_CATALOG_URLS.models as [string, string];

const [CODEX_URL] = DEFAULT_CATALOG_URLS.codexClient as [string];

const [DEVIN_URL] = DEFAULT_CATALOG_URLS.devin as [string];

const embeddedCodexText = JSON.stringify(codexClientJson);

const runRefresh = (
  kv: FakeKv,
  responses: Record<string, string | number>,
  yaml = "",
  requested: string[] = [],
) => refreshCatalogs.pipe(Effect.provide(refreshLayer(kv, fakeHttp(responses, requested), yaml)));

describe("resolveSource", () => {
  it("maps the models.* values", () => {
    assert.deepStrictEqual(resolveSource("", "models"), {
      mode: "fetch",
      urls: DEFAULT_CATALOG_URLS.models,
    });
    assert.deepStrictEqual(resolveSource(" https://x.test/m.json ", "devin"), {
      mode: "fetch",
      urls: [" https://x.test/m.json "].map((u) => u.trim()),
    });
    assert.deepStrictEqual(resolveSource("embed", "models"), { mode: "embed" });
    assert.deepStrictEqual(resolveSource("disabled", "models"), { mode: "disabled" });
    assert.strictEqual(resolveSource("/etc/models.json", "models").mode, "disabled");
    assert.strictEqual(resolveSource("ftp://x/y", "models").mode, "disabled");
  });
});

describe("refreshCatalogs (cron)", () => {
  it.effect(
    "publishes valid catalogs from the first source into KV and reports changed providers",
    () =>
      Effect.gen(function* () {
        const kv = new FakeKv();
        const requested: string[] = [];

        const outcomes = yield* runRefresh(
          kv,
          {
            [MODELS_URL]: catalogText(["new-claude"], ["muse-new"]),
            [CODEX_URL]: embeddedCodexText,
            [DEVIN_URL]: JSON.stringify({ devin: [entry("only")] }),
          },
          "",
          requested,
        );

        assert.deepStrictEqual(
          outcomes.map((outcome) => [outcome.catalog, outcome.status]),
          [
            ["models", "updated"],
            ["codexClient", "updated"],
            ["devin", "updated"],
          ],
        );
        assert.deepStrictEqual(requested, [MODELS_URL, CODEX_URL, DEVIN_URL]);
        assert.isTrue(outcomes[0]?.changedProviders?.includes("claude"));
        assert.strictEqual(
          kv.data.get(CATALOG_KEYS.models),
          catalogText(["new-claude"], ["muse-new"]),
        );
        assert.isDefined(kv.data.get(CATALOG_KEYS.status));
      }),
  );

  it.effect(
    "tries the mirror when the first source is unreachable or invalid and is idempotent",
    () =>
      Effect.gen(function* () {
        const kv = new FakeKv();

        const responses = {
          [MODELS_URL]: "<html>not json</html>",
          [MODELS_MIRROR]: catalogText(["mirror-claude"]),
          [CODEX_URL]: 500,
          [DEVIN_URL]: 404,
        };

        const first = yield* runRefresh(kv, responses);
        assert.deepStrictEqual(
          first.map((outcome) => [outcome.catalog, outcome.status, outcome.source]),
          [
            ["models", "updated", MODELS_MIRROR],
            ["codexClient", "failed", undefined],
            ["devin", "failed", undefined],
          ],
        );
        const second = yield* runRefresh(kv, responses);
        assert.strictEqual(second[0]?.status, "unchanged");
        assert.strictEqual(kv.puts.filter((key) => key === CATALOG_KEYS.models).length, 1);
      }),
  );

  it.effect("keeps the last valid catalog when every source is rejected", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();
      kv.data.set(CATALOG_KEYS.models, catalogText(["kept"]));

      const outcomes = yield* runRefresh(kv, {
        [MODELS_URL]: JSON.stringify({ claude: [null] }),
        [MODELS_MIRROR]: "{}x",
      });

      assert.strictEqual(outcomes[0]?.status, "failed");
      assert.strictEqual(kv.data.get(CATALOG_KEYS.models), catalogText(["kept"]));
    }),
  );

  it.effect("a catalog without meta keeps the previous meta section (stored, else embedded)", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();
      yield* runRefresh(kv, { [MODELS_URL]: catalogText(["a"]) });

      const merged = JSON.parse(kv.data.get(CATALOG_KEYS.models) ?? "{}") as {
        meta: Array<{ id: string }>;
      };

      const embeddedMeta = (modelsJson as unknown as { meta: Array<{ id: string }> }).meta.map(
        (model) => model.id,
      );

      assert.deepStrictEqual(
        merged.meta.map((model) => model.id),
        embeddedMeta,
      );

      const kv2 = new FakeKv();
      kv2.data.set(CATALOG_KEYS.models, catalogText(["old"], ["stored-meta"]));
      yield* runRefresh(kv2, { [MODELS_URL]: catalogText(["b"]) });

      const merged2 = JSON.parse(kv2.data.get(CATALOG_KEYS.models) ?? "{}") as {
        meta: Array<{ id: string }>;
      };

      assert.deepStrictEqual(
        merged2.meta.map((model) => model.id),
        ["stored-meta"],
      );
    }),
  );

  it.effect("rejects responses above the 8 MiB limit", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();

      const huge = JSON.stringify({
        ...JSON.parse(catalogText(["x"])),
        pad: "x".repeat(MAX_CATALOG_BYTES),
      });

      const outcomes = yield* runRefresh(kv, { [MODELS_URL]: huge, [MODELS_MIRROR]: huge });
      assert.strictEqual(outcomes[0]?.status, "failed");
    }),
  );

  it.effect(
    "explicit sources replace the defaults; embed clears the override; disabled skips",
    () =>
      Effect.gen(function* () {
        const kv = new FakeKv();
        kv.data.set(CATALOG_KEYS.devin, JSON.stringify({ devin: [entry("stale")] }));
        const requested: string[] = [];
        const yaml = `models:\n  catalog: https://example.test/custom.json\n  codex-catalog: disabled\n  devin-catalog: embed\n`;

        const outcomes = yield* runRefresh(
          kv,
          { "https://example.test/custom.json": catalogText(["custom"]) },
          yaml,
          requested,
        );

        assert.deepStrictEqual(requested, ["https://example.test/custom.json"]);
        assert.deepStrictEqual(
          outcomes.map((outcome) => outcome.status),
          ["updated", "skipped", "updated"],
        );
        assert.isFalse(kv.data.has(CATALOG_KEYS.devin));
      }),
  );

  it.effect("storage failures are reported per catalog, never thrown", () =>
    Effect.gen(function* () {
      const kv = new FakeKv();
      kv.failPut = true;
      const outcomes = yield* runRefresh(kv, { [MODELS_URL]: catalogText(["x"]) });
      assert.strictEqual(outcomes[0]?.status, "failed");
    }),
  );
});

describe("CatalogStore", () => {
  it.effect(
    "serves the embedded catalogs, then KV copies after the cache TTL, and survives KV errors",
    () => {
      const kv = new FakeKv();

      return Effect.gen(function* () {
        const store = yield* CatalogStore;
        const before = yield* store.load;
        assert.strictEqual(before.models.claude.length, embeddedCatalogs().models.claude.length);

        kv.data.set(CATALOG_KEYS.models, catalogText(["from-kv"]));
        const cached = yield* store.load;
        assert.strictEqual(cached, before);

        yield* TestClock.adjust(CATALOG_CACHE_TTL_MS + 1);
        const after = yield* store.load;
        assert.deepStrictEqual(
          after.models.claude.map((model) => model.id),
          ["from-kv"],
        );

        kv.get = async () => {
          throw new Error("kv down");
        };

        yield* TestClock.adjust(CATALOG_CACHE_TTL_MS + 1);
        const stale = yield* store.load;
        assert.strictEqual(stale, after);
      }).pipe(Effect.provide(Layer.mergeAll(CatalogStore.layer, workerEnv(kv))));
    },
  );
});
