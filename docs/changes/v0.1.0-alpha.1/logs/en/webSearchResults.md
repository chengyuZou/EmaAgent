# Unrelated WebSearch results

[中文](../zh/webSearchResults.md)

## Status and scope

Investigation started on 2026-10-19, updated on 2026-10-20. The user reports recovery after restarting Ema only, with no other changes. The cause remains unconfirmed, no fix was applied, and active investigation has stopped. Keep the issue open for a future recurrence report, without scheduled monitoring. The local source was exercised independently; this does not establish which exact source revision or provider the installed application used.

The user reported a successful WebSearch call whose game-related query returned Outlook tutorials. This investigation made public search requests, but did not start Ema, invoke a paid model, read user databases, or change saved provider credentials. A later temporary test file and source probes were removed after use; the three instrumented business files matched their pre-probe SHA-256 hashes exactly. Restarting the installed application and providing its screenshots were user actions.

## Controls and reproduction

The conversation's native web search returned related pages for the same query, including a [CG collection guide](https://www.bilibili.com/read/cv42390779). This is a relevance control, not evidence that native search uses the same provider, network route, or HTML interface as Ema.

The current [provider selection](../../../../../src/builtin-tools/tools/WebSearchTool/adapters/index.ts) uses Brave when a supported Brave API-key environment variable is present, otherwise Bing HTML. It does not alternate providers or merge their results. The installed process environment was not inspected.

The reproduction called the real [Bing adapter](../../../../../src/builtin-tools/tools/WebSearchTool/adapters/bing.ts) directly, without the Agent, Tool scheduler, UI, or another concurrent operation. Run from the repository root in PowerShell with the existing dependencies and Node.js 24.13.0:

```powershell
@'
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
    throw error;
  }
} });
const { bingSearch } = await import('./src/builtin-tools/tools/WebSearchTool/adapters/bing.ts');
const results = await bingSearch('魔法少女的魔女审判 樱羽艾玛 二阶堂希罗 CG 白发 粉发 笑 天空', { signal: AbortSignal.timeout(35000) });
console.log(JSON.stringify(results.map(item => ({ title: item.title, url: item.url })), null, 2));
const related = results.filter(item => /魔女|樱羽|櫻羽|艾玛|艾瑪|希罗|希羅|majo|witch|sakuraba|nikaido/i.test(item.title + ' ' + item.snippet));
console.log('Repeat fixture topic hits:', related.length);
assert.ok(related.length > 0, 'REPRO: no result mentions this game or its characters');
'@ | node --experimental-transform-types --input-type=module -
```

The import hook only resolves the source's relative `.js` imports to `.ts` files in this standalone process. It does not alter files. An earlier attempt using `tsx` failed with `spawn EPERM` before making a search request; the native Node TypeScript loader avoided that subprocess requirement.

The assertion is specific to this reproduction query, not a proposed production relevance filter. Two direct adapter runs returned 10 results each and zero topic hits. The first contained generic Bilibili home, download and other entry pages; the second contained BB30-2K-K bearings. The repeat command above ended with:

```text
Repeat fixture topic hits: 0
AssertionError [ERR_ASSERTION]: REPRO: no result mentions this game or its characters
exit code: 1
```

The exact unrelated topic changed between requests. This is a live-network reproduction, not a deterministic fixture; two failures establish observed recurrence, not a guaranteed failure rate.

## Response boundary checks

After reproducing the problem, the checks distinguished three possibilities: the fetched HTML already contained unrelated results, the parser selected a different page region, or request market/query conditions affected the result. Responses were cloned in memory and inspected without saving HTML or changing application files.

| Request | Observed response | Parsed result |
| --- | --- | --- |
| Unchanged query and adapter request | HTTP 200, redirected from www.bing.com to cn.bing.com; request query, final URL query, page title and search-box value all retained the supplied query | 10 Qwen-related entries, matching the HTML search-result titles |
| Only setmkt changed from en-US to zh-CN | Correct query still present in the URL, title and search box | 9 Weixin Official Accounts entries, matching the HTML search-result titles |
| Only query shortened to the game title and Ema's name | Correct shortened query still present in the URL, title and search box | 10 spin-orbit torque entries, matching the HTML search-result titles |

For all three checks, `ol#b_results li.b_algo` contained the same number of entries as the parser's `li.b_algo` selection, and the titles read inside that search-result container matched the adapter output. In these responses, unrelated entries were already in the received HTML, not introduced by choosing an unrelated sidebar during parsing.

## Later direct-request and source-probe checks

Direct native fetch requests to the user's exact `cn.bing.com/search?q=...` URL, without custom headers or automatic redirects, returned HTTP 200 and identical relevant result titles three times in succession. Later requests to the CN address also returned related results when adding the original market parameter, original headers, or both. A manual request to the original www address returned HTTP 302 with the expected CN destination.

Temporary probes then traced Tool input, provider selection, actual network requests and redirect responses, response body, encoding and parsing, filtering, and model-facing output. The harness exercised `WebSearchTool.execute` and `mapResultToModelContent`, without the running installed Server, Agent scheduler, or chat UI. Brave credential variables were cleared only inside the isolated test process to select Bing without invoking a keyed API; no application configuration was changed.

| Source test | Search calls | Observed result |
| --- | ---: | --- |
| Original WebSearch request, with original headers, parameters and automatic redirects | 12 | All returned 10 relevant entries and preserved the query and model-facing links |
| Same request sent directly to cn.bing.com | 3 | All returned 10 relevant entries and preserved the query and model-facing links |
| Original request with manual hop-by-hop following of Location | 3 | All returned 10 relevant entries and preserved the query and model-facing links |
| Standalone Bing adapter calls with source probes disabled | 3 | All returned 10 relevant entries |

The temporary harness command for the 10-call repeat was `node --experimental-transform-types src/builtin-tools/tests/webSearchProbe.mjs original 10`. Its summaries reported `count: 10`, `topicHits: 10`, `queryPreserved: true`, and `modelLinksPreserved: true` for every call, with exit code 0. The initial original-mode run made the other two calls. The temporary file no longer exists and this command is retained only as the executed test record.

The unchanged request still followed `www.bing.com -> 302 -> cn.bing.com -> 200`. Its query was preserved at both hops. Body result titles agreed between the normal buffer parser and an explicit UTF-8 decoding check, and the parsed results remained consistent through filtering and model output. This later run did not reproduce the earlier unrelated-result failure, so automatic redirection is not established as its cause.

## Installed-app recovery report

On 2026-10-20 the user confirmed that they restarted Ema and made no other changes before the same query returned related game and character results. They did not report changing the proxy or environment variables. The supplied screenshots show an earlier Outlook result in history and relevant entries in a newer search.

One subsequent WebFetch failed and another succeeded. Those calls fetch individual result pages and are not evidence that the newer WebSearch failed. No error details were inspected for that WebFetch. A related result list also does not prove that the requested specific CG was found or every statement in the answer was verified.

Restarting and recovery are observed in that order; the evidence does not show which process state, network condition, or other factor changed. The later successful independent source tests and the installed-app restart report are separate observations, not a controlled before-and-after experiment.

## Supported conclusion and stopping point

The earlier independent tests returned irrelevant results without Tool scheduling or concurrent Agents. Later tests of the same source path returned related results, and the user reports the installed application recovered after a restart. Preserve both observations. Correct query text in a page does not establish correct search results. The adapter checks status, page structure and challenge indicators, but the earlier unrelated responses passed those checks.

This evidence does not identify whether the unexpected HTML originates from the upstream search service, an intervening network component, or other request conditions. It also does not prove that the installed application's original Outlook result had exactly the same cause, or that scheduling is correct in every other scenario. The initial market/query changes did not resolve the failure at that time, while the later unchanged source requests succeeded. Neither phase establishes a confirmed corrective change.

Removing Brave and leaving Bing alone is not a demonstrated fix. No provider was removed or disabled, and no network permissions were relaxed. Current status: recovered, cause unconfirmed, awaiting a future user report rather than active investigation. No database inspection, further network testing, or implementation changes are planned in this task. No package test suite or installer rebuild was run; the user's recovery report is not a verified fix regression test.
