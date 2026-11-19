# Third-party notices

Moco's original code is licensed under the GNU Affero General Public License,
version 3 only (`AGPL-3.0-only`); see [LICENSE](LICENSE). Third-party code,
documentation, runtimes, models, and services retain their own copyrights,
licenses, and terms. Moco's license does not replace those terms or grant rights
to third-party services, accounts, or trademarks.

This file identifies the direct runtime dependencies, bundled upstream skill
material, and selected optional components used by this source revision. Package
versions below refer to the resolved dependencies in [pnpm-lock.yaml](pnpm-lock.yaml),
except where an integration pins a separately installed component. Dependencies
of those packages also retain their upstream licenses and notices. Preserve the
`LICENSE`, `COPYING`, `NOTICE`, and third-party notice files supplied with any
components you redistribute.

## Core libraries and tools

| Component | Version | Upstream | License / terms |
| --- | --- | --- | --- |
| `@earendil-works/pi-ai`, `pi-durable`, `pi-env`, `pi-schema`, `chord` | 1.5.2 each | [Pi](https://github.com/earendil-works/pi) | MIT; [retained notice](licenses/pi-LICENSE) |
| `@vectorize-io/hindsight-client` | 1.2.1 | [Hindsight](https://github.com/vectorize-io/hindsight) | MIT |
| `@json-render/core`, `@json-render/react` | 0.23.1 each | [json-render](https://github.com/vercel-labs/json-render) | Apache-2.0 |
| `@heroui/react`, `@heroui/styles` | 3.2.7 each | [HeroUI](https://github.com/heroui-inc/heroui) | Apache-2.0 |
| `react`, `react-dom` | 19.3.1 each | [React](https://github.com/react/react) | MIT |
| `skills` | 1.9.0 | [Vercel Skills](https://github.com/vercel-labs/skills) | MIT; includes its own `ThirdPartyNoticeText.txt` |
| `agent-browser` | 0.43.0 | [agent-browser](https://github.com/vercel-labs/agent-browser) | Apache-2.0 |
| `agent-desktop` | 1.3.1 | [agent-desktop](https://github.com/vercel-labs/agent-desktop) | Apache-2.0 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.326 | [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) | Anthropic terms; [retained notice](licenses/claude-agent-sdk-0.3.326-LICENSE.md) |
| `ffmpeg-static` | 5.3.0 | [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | GPL-3.0-or-later for the npm package; downloaded FFmpeg binaries have their own applicable licenses |
| `sherpa-onnx-node` | 2.0.1 | [sherpa-onnx](https://github.com/csukuangfj/sherpa-onnx) | Apache-2.0; models and native dependencies have separate notices |

The Pi MIT notice credits Mario Zechner. Pi Schema also includes a TypeBox MIT
notice in its own `THIRD_PARTY_NOTICES/typebox-LICENSE`; that notice remains
applicable to the included TypeBox material.

## Other direct runtime dependencies

| Component | Version | Upstream | License |
| --- | --- | --- | --- |
| `@brave/brave-search-mcp-server` | 2.1.4 | [Brave Search MCP Server](https://github.com/brave/brave-search-mcp-server) | MIT |
| `@modelcontextprotocol/sdk` | 1.32.2 | [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| `@mozilla/readability` | 0.6.0 | [Readability](https://github.com/mozilla/readability) | Apache-2.0 |
| `acorn` | 8.19.0 | [Acorn](https://github.com/acornjs/acorn) | MIT |
| `https-proxy-agent` | 9.1.0 | [Proxy Agents](https://github.com/TooTallNate/proxy-agents) | MIT |
| `linkedom` | 0.18.15 | [LinkeDOM](https://github.com/WebReflection/linkedom) | ISC |
| `pi-web-access` | 0.48.0 | [pi-web-access](https://github.com/nicobailon/pi-web-access) | MIT |
| `pnpm` | 11.25.0 | [pnpm](https://github.com/pnpm/pnpm) | MIT |
| `undici` | 8.12.4 | [Undici](https://github.com/nodejs/undici) | MIT |
| `ws` | 8.22.2 | [ws](https://github.com/websockets/ws) | MIT |
| `yaml` | 2.9.1 | [YAML](https://github.com/eemeli/yaml) | ISC |
| `zod` | 4.6.7 | [Zod](https://github.com/colinhacks/zod) | MIT |
| `@internationalized/date` | 3.12.4 | [React Spectrum](https://github.com/adobe/react-spectrum) | Apache-2.0 |
| `@react-aria/ssr` | 3.10.1 | [React Spectrum](https://github.com/adobe/react-spectrum) | Apache-2.0 |
| `@react-aria/utils` | 3.34.1 | [React Spectrum](https://github.com/adobe/react-spectrum) | Apache-2.0 |
| `react-aria` | 3.53.1 | [React Spectrum](https://github.com/adobe/react-spectrum) | Apache-2.0 |
| `react-aria-components` | 1.22.1 | [React Spectrum](https://github.com/adobe/react-spectrum) | Apache-2.0 |
| `pdfjs-dist` | 6.5.438 | [PDF.js](https://github.com/mozilla/pdf.js) | Apache-2.0 |
| `qrcode.react` | 4.2.0 | [qrcode.react](https://github.com/zpao/qrcode.react) | ISC |
| `react-markdown` | 10.1.0 | [react-markdown](https://github.com/remarkjs/react-markdown) | MIT |
| `remark-cjk-friendly` | 2.3.4 | [markdown-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly) | MIT |
| `remark-cjk-friendly-gfm-strikethrough` | 2.3.3 | [markdown-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly) | MIT |
| `remark-gfm` | 4.0.1 | [remark-gfm](https://github.com/remarkjs/remark-gfm) | MIT |
| `shiki` | 4.6.0 | [Shiki](https://github.com/shikijs/shiki) | MIT |

## Bundled skill documentation

Moco includes the following upstream skill documentation. Each skill directory
contains its license and a `PROVENANCE.json` recording the source revision and
file hashes. The upstream documentation is retained unchanged; Moco's routing
instructions are in the parent `SKILL.md`. Upstream executable scripts and
templates are not part of these copied skill documents.

| Moco skill directory | Upstream and pinned revision | Retained license |
| --- | --- | --- |
| `browser-automation` | [agent-browser 0.43.0](https://github.com/vercel-labs/agent-browser/tree/1cc19526f3641c8543d55aa6700e7c55b37ac356/skill-data/core) | [Apache-2.0](packages/hub/skills/browser-automation/LICENSE) |
| `desktop-automation` | [agent-desktop 1.3.1](https://github.com/vercel-labs/agent-desktop/tree/b0b7277bea09b770ef9d1fb45aad667bc432cd57/skills/agent-desktop) | [Apache-2.0](packages/hub/skills/desktop-automation/LICENSE) |
| `desktop-linux` | [agent-desktop 1.3.1](https://github.com/vercel-labs/agent-desktop/tree/b0b7277bea09b770ef9d1fb45aad667bc432cd57/skills/agent-desktop-linux) | [Apache-2.0](packages/hub/skills/desktop-linux/LICENSE) |
| `desktop-macos` | [agent-desktop 1.3.1](https://github.com/vercel-labs/agent-desktop/tree/b0b7277bea09b770ef9d1fb45aad667bc432cd57/skills/agent-desktop-macos) | [Apache-2.0](packages/hub/skills/desktop-macos/LICENSE) |
| `desktop-windows` | [agent-desktop 1.3.1](https://github.com/vercel-labs/agent-desktop/tree/b0b7277bea09b770ef9d1fb45aad667bc432cd57/skills/agent-desktop-windows) | [Apache-2.0](packages/hub/skills/desktop-windows/LICENSE) |
| `vercel-composition-patterns` | [agent-skills, revision 1a2c79d](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/composition-patterns) | [MIT declaration and terms](packages/hub/skills/vercel-composition-patterns/LICENSE) |
| `vercel-react-best-practices` | [agent-skills, revision 1a2c79d](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/react-best-practices) | [MIT declaration and terms](packages/hub/skills/vercel-react-best-practices/LICENSE) |
| `web-design-guidelines` | [agent-skills, revision 1a2c79d](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/web-design-guidelines) | [MIT declaration and terms](packages/hub/skills/web-design-guidelines/LICENSE) |
| `web-design-guidelines/references/web-interface-guidelines.md` | [web-interface-guidelines, revision 434b7f9](https://github.com/vercel-labs/web-interface-guidelines/blob/434b7f91364665f2f733b310ec54809bf8f37937/command.md) | [MIT](packages/hub/skills/web-design-guidelines/references/LICENSE) |

At the pinned `agent-skills` revision, the upstream README and skill frontmatter
declare MIT, but the repository supplies no standalone license file or copyright
notice. The retained files document that declaration, include the MIT permission
text, and preserve the notices present in the original material.

## Billion Context and acp-kernel

Moco uses [acp-kernel](https://github.com/ranxianglei/acp-kernel), from the
[Billion Context](https://github.com/ranxianglei/billion-context) project, for its
optional Billion Context compression integration. The integration installs
`acp-kernel` **0.0.101** separately and is disabled by default.

Copyright (c) 2026 ranxianglei. The upstream licenses contain the MIT terms **plus
an additional product attribution requirement**. The package's `MIT` metadata
does not replace that additional text. Products or services using this software
must visibly credit acp-kernel and Billion Context, as applicable, and link to
their repositories on a home page, in documentation, or on an About / Credits /
Acknowledgements page. For uses with no user-facing surface, the upstream term
permits the attribution in shipped documentation.

The complete notices are preserved in
[acp-kernel-0.0.101-LICENSE](licenses/acp-kernel-0.0.101-LICENSE) and
[billion-context-LICENSE](licenses/billion-context-LICENSE). The latter is the
[upstream project license](https://github.com/ranxianglei/billion-context/blob/master/LICENSE)
retrieved on 2026-11-17; Moco does not bundle a separate Billion Context application.

## Claude Agent SDK and external agents

The Env package depends on `@anthropic-ai/claude-agent-sdk` **0.3.326**. Its
[license notice](licenses/claude-agent-sdk-0.3.326-LICENSE.md) reserves Anthropic's
rights and refers to [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance).
It is not licensed by Moco under AGPL, MIT, or Apache-2.0. Its use and any
redistribution remain subject to the applicable Anthropic terms.

External agent clients and services invoked through Moco, including separately
installed Codex or other command-line agents, retain their own licenses,
authentication requirements, and service terms. Support for invoking a client
does not mean that client or its hosted service is included in this repository.

## FFmpeg and speech components

Moco uses `ffmpeg-static` **5.3.0** to locate an FFmpeg executable for audio
decoding. The npm package declares `GPL-3.0-or-later` and supplies a GPLv3
`LICENSE`. The platform-specific executable downloaded by that package is a
separate FFmpeg build; the package documentation explicitly assigns it its own
applicable license. Preserve that build's `ffmpeg.LICENSE` and accompanying
notices when redistributing it.

FFmpeg's license depends on the code and optional libraries enabled in the
particular build. Moco invokes the executable as a subprocess. The npm package's
license field alone does not determine the license of a downloaded binary or the
licensing status of a complete application distribution. Distributors must
identify the exact FFmpeg build they ship and meet its applicable notice and
corresponding-source requirements. See [FFmpeg's license information](https://www.ffmpeg.org/legal.html)
and the [ffmpeg-static sources and binary provenance](https://github.com/eugeneware/ffmpeg-static).

The local speech engine uses `sherpa-onnx-node` **2.0.1** (Apache-2.0). Its native
libraries retain their own notices. The optional speech-model download is
`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17` from
[sherpa-onnx's model releases](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models).
Moco extracts the model archive's `LICENSE` and `README.md` alongside the model
and tokenizer. Those model terms apply independently of the engine's license.

## Desktop runtimes and optional memory service

- **Electron 45.3.3**: [Electron](https://github.com/electron/electron) is MIT
  licensed and includes Chromium and other components with their own notices.
  Keep the license and third-party notices supplied with the exact Electron
  distribution used to build a desktop release.
- **Node.js**: the desktop packager copies the build's standalone Node.js runtime
  and its complete license file as `NODE-LICENSE`. The Node.js version depends on
  the build runtime. Node.js and its included dependencies retain the terms in
  that file; see [Node.js](https://github.com/nodejs/node).
- **Hindsight API**: Moco's optional local memory deployment pins
  `hindsight-api-slim==1.2.1` (MIT) in
  [the integration manifest](integrations/hindsight/pyproject.toml). The deployment
  installs Hindsight and its Python dependencies separately; their license files
  remain applicable. An independently operated Hindsight service is not
  relicensed by Moco. See [Hindsight](https://github.com/vectorize-io/hindsight).

The license snapshots in `licenses/` and the licenses alongside bundled skills
supplement the original component notices. They do not replace notices for a
different dependency version, native payload, model, or service selected by a
particular installation.
