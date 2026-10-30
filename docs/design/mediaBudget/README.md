# Why media sources share a sending budget

[中文](README-zh.md) | [Documentation](../../README.md)

Token capacity is not the only constraint on a model request. Accumulating images and other media can make the encoded request large enough to fail even before text reaches the context-window limit.

## Why we do not limit computer screenshots alone

We considered keeping only the most recent few computer observations. A task's important history may consist mainly of those images, so a small special quota can discard evidence too early. Ordinary attachments can accumulate too; treating screenshots alone does not control the whole request.

Attachments, computer observations, and other tool-result images therefore follow one rule. Item count and encoded bytes jointly constrain outgoing media rather than giving each source a separate fixed quota. Supported audio and files count against the same media budget.

The cost is competition between sources. A shared rule does not keep every old frame a task needs, but avoids assuming that one source should always be removed sooner.

## Why we process sending copies

We want smaller encoded requests while preserving local material and history. Processing applies to outgoing copies, not original SQL messages or files.

Opaque PNGs are tried as smaller JPEGs; transparent images stay PNG. Only a smaller result is adopted, without changing the outgoing copy's dimensions in this step. Computer operations use image coordinates, making arbitrary resizing harder to reconcile with click positions.

We accept that lossy encoding can affect small text and that re-encoded transparent images may remain large. Compression reduces size but does not stop accumulation, so an overall budget remains necessary.

## Why older media is omitted first

We prioritize newer complete media items and replace older items outside the budget with explicit notices. Base64 is not cut short, and no description is invented for an omitted image. Message positions and tool-call pairing remain intact.

If the newest item alone exceeds the byte budget, the request fails explicitly so the user can reduce the attachment or adjust settings. Silently omitting the only new image could let the model answer without seeing it.

The cost is losing direct access to older visual evidence during long comparisons. Original media remains in local history or attachments; reading it again depends on available references and tools, not an assumption that the model automatically recovers everything.

## What the budget does not guarantee

Settings constrain outgoing media count and encoded bytes, including base64 expansion, not the provider's entire HTTP request limit. A URL contributes its transmitted address, which cannot predict how much remote content the provider may fetch.

We first handle what can be established locally. Models and gateways can impose further limits, and an oversized HTTP body needs to be distinguished from token context overflow. Defaults and conversion contracts are in [Context](../../../src/context/README.md).
