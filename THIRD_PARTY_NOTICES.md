# Reused source

Polygate incorporates opencode-free-bridge at commit fe0b64c3fcebe2f441008d9b87161d115cfe8fdb, copyright (c) 2026 azrinaldi, under the MIT license reproduced at vendor/bridge/LICENSE. The vendored runtime is adapted to resolve two optional imports statically for bundling. Its in-place self-updater is disabled by Polygate. https://github.com/azrinaldi/opencode-free-bridge

ProxyTool / ProxyHive at commit 87ff5438f1adcaf5b2d083614fb02a8b6a8377f7 is the user's supplied project, copyright B3hnamR. It is reused under the user's explicit instruction to copy and modify their code. No public redistribution license was present in that snapshot; this local build does not assign it a new license. The Python sources and dashboard were removed from this project on 26 October 2026; only the list of public proxy sources is kept (backend/proxy-sources.ts). User data, pools, history and settings from the original project were not copied.

Other reviewed projects informed architecture; their source is not incorporated unless separately listed here. Electron, React, Bun and Lucide retain their respective licenses. Electron's bundled notices ship with the packaged runtime.

Protocol adapters are derived from 12errh/zen-proxy at 1e87076453974cfc11cf598219a71362021118d0, copyright (c) 2026 12errh, under MIT; the license is retained at vendor/protocols/LICENSE. Original standalone startup and exception handlers were removed.

WARP engine and activation work follows Nystic-Shadow/Opencode2api and Maicon501a/opencode-zen-proxy. Copyright (c) 2026 OpenCode2API Contributors and copyright (c) 2026 Maicon, respectively. Their MIT notices are retained under vendor/licenses. Polygate ports these capabilities into its own modules; it does not run a second Nystic gateway.

The relay templates were supplied locally by the user from 9router Proxy Pool Data and reviewed alongside AutoZCoder. No deployment accounts or credentials were copied.

# Polygate's own license, and components that are not copied into the source

Polygate's own code is under the MIT license in LICENSE (copyright (c) 2026 B3hnAM). The third-party source listed above keeps the licenses named there.

Packages and downloads keep their own licenses and are not relicensed by Polygate:
- Bun (the runtime that runs the gateway, bundled in the Windows app and Linux packages and used by Docker) is pinned to 1.4.4. Official tag `bun-v1.4.4` resolves to `38afee6c84fcf48c0edb2466aa4b27d287a59c30`. The upstream `LICENSE.md` is retained at `vendor/licenses/bun-1.4.4/LICENSE.md`; it identifies Bun itself as MIT and enumerates separately licensed static libraries, embedded polyfills and other incorporated code. This is the release's upstream license overview, not a consolidated full-text license collection. No terms have been substituted from `@types/bun`, `bun-types` or npm license metadata. See the exact-source evidence and remaining redistribution requirements below.
- React 19.3.1, React DOM 19.3.1 and Scheduler 0.28.0 (dashboard) have identical MIT notices in the locally installed packages. Their complete notice is copied at `vendor/licenses/react-LICENSE` from `node_modules/react/LICENSE`, also checked against `node_modules/react-dom/LICENSE` and `node_modules/scheduler/LICENSE`.
- Lucide React 0.468.0 (dashboard) is ISC-licensed. Its complete locally installed notice, including the Feather attribution, is copied from `node_modules/lucide-react/LICENSE` at `vendor/licenses/lucide-react-LICENSE`.
- Electron (Windows app) is MIT-licensed; its bundled runtime notices are supplied by Electron packaging. No newly built package was inspected for this provenance update.
- The WARP helper is supplied as a locally patched build of usque v4.2.1 (https://github.com/Diniboy1123/usque), copyright (c) 2025 Diniboy1123, under the MIT license reproduced at resources/warp/LICENSE. Polygate bundles the helper and ships the supplied local patch at resources/warp/usque.patch. The patch points registration at `api.devices.cloudflare.com`, fragments the first part of the TLS ClientHello on networks that reset it, and enables HTTP/2 keepalive so idle tunnels stay up. The helper runs as a separate process; no usque code is linked into Polygate. Hashes establish the identity of the supplied files, not that the patch reproduces them.
- npm build dependencies retain their own licenses. The notices above cover identified bundled dashboard components, not a complete inventory of every build dependency.

# Bundled Dashboard Fonts

`src/main.tsx` imports Barlow, Barlow Condensed and Doto from the locally installed Fontsource packages, each at version 5.3.0. Their complete copyright statements and SIL Open Font License 1.1 texts are copied unchanged from the corresponding installed `LICENSE` files:

| Font | Local source | Retained notice |
|---|---|---|
| Barlow | `node_modules/@fontsource/barlow/LICENSE` | `vendor/licenses/fontsource-barlow-LICENSE` |
| Barlow Condensed | `node_modules/@fontsource/barlow-condensed/LICENSE` | `vendor/licenses/fontsource-barlow-condensed-LICENSE` |
| Doto | `node_modules/@fontsource/doto/LICENSE` | `vendor/licenses/fontsource-doto-LICENSE` |

The existing Agent font notices below are retained. These added notices do not assert a legal violation or depend on whether font binaries contain readable embedded notices.

# Notice Packaging And Verification Limits

Desktop packaging copies `vendor/licenses` to `licenses` beside `THIRD_PARTY_NOTICES.md`; Linux archives and Docker images copy it to `vendor/licenses` beside this notice. The retained paths above refer to the source/Linux/Docker layout; on desktop replace the `vendor/licenses/` prefix with `licenses/`. These are source-level packaging contracts, not a claim that current release artifacts were rebuilt or inspected.

On 9 November 2026, read-only SHA256 hashing found that all three supplied WARP helper files match `resources/warp/sha256.txt`:

| Helper | SHA256 |
|---|---|
| `usque-linux-amd64` | `8bc6f530308f5a63443784540df05936cbf923cf752564b0f40bf0911437a5cf` |
| `usque-linux-arm64` | `f52563f88d49eb2f982e68f7a7ffa24c60e4fb8ecdd5b45c47979fa2d387dcf5` |
| `usque-windows-amd64.exe` | `4284936a0f6299353551abe9e470df93332669b309dc395e1e0ff21faf3854cf` |

No helper binary was executed or overwritten. The pinned usque `go.mod` was read from official public source; compiler/dependency availability, embedded build information and patch-to-binary equivalence were not independently verified, and no rebuild was performed. `scripts/build-warp-helper.sh` now defaults to a separate-output comparison, records source/patch/recipe hashes and toolchain/module/build settings, and disables implicit toolchain and module downloads. See `resources/warp/README.md`. Hash identity is not reproduction evidence.

# Bun 1.4.4 Exact-Source Evidence And Release Gaps

Official public source was read on 9 November 2026, without running upstream code or downloading a toolchain. Release identity: https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.4. Source: https://github.com/oven-sh/bun/tree/38afee6c84fcf48c0edb2466aa4b27d287a59c30.

| Retained material | Exact upstream URL | Upstream Git blob SHA1 |
|---|---|---|
| `vendor/licenses/bun-1.4.4/LICENSE.md` | https://raw.githubusercontent.com/oven-sh/bun/38afee6c84fcf48c0edb2466aa4b27d287a59c30/LICENSE.md | `3e1b37f1c940c9f37da76d82a38b1246b9952061` |
| `vendor/licenses/bun-1.4.4/JavaScriptCore-COPYING.LIB` | https://raw.githubusercontent.com/oven-sh/WebKit/d6375c72affe0f70222cdcb45012b10f0bf3a9d5/Source/JavaScriptCore/COPYING.LIB | `87c4a33dd850415a33a816146eaf09a07912c4d6` |
| `vendor/licenses/bun-1.4.4/TinyCC-COPYING` | https://raw.githubusercontent.com/oven-sh/tinycc/05f0fafaa3be31e31d7b4b5c17dc60f62c991171/COPYING | `223ede7de3ec74eb86253f9ce9ed7ba3c5aa9130` |

The exact Bun source's `scripts/build/deps/webkit.ts` pins WebKit/JavaScriptCore to `d6375c72affe0f70222cdcb45012b10f0bf3a9d5`; its `scripts/build/deps/tinycc.ts` pins TinyCC to `05f0fafaa3be31e31d7b4b5c17dc60f62c991171` and applies `patches/tinycc/tcc.h.patch`. These are source-version pointers, not proof that the locally supplied Bun executables were built from those inputs. Git blob hashes identify exact retained upstream content independently of mutable tags; they are not signatures or binary attestations.

JavaScriptCore/WebKit is used in the Bun executable and is covered in part by GNU Library GPL version 2, retained in `JavaScriptCore-COPYING.LIB`; file-specific BSD and other terms also apply in that source tree. TinyCC is listed by Bun as statically linked under LGPL 2.1, retained in `TinyCC-COPYING` (applicability varies by target/build). Nothing in Polygate's own MIT license restricts modification for the recipient's own use or reverse engineering for debugging modifications of these libraries. The retained LGPL section 6 terms require more than notices: corresponding library source including modifications, the work that uses the library in relinkable object and/or source form, necessary build data/utilities, and an applicable delivery mechanism (or a valid offer where permitted). The upstream Bun overview gives relinking instructions; they have not been executed or validated here. This document does not make an unfulfilled three-year written offer or claim that external links alone discharge those obligations.

**Unresolved before asserting complete binary redistribution compliance:** obtain and retain all applicable copyright notices and full license texts for the exact bundled runtime's dependencies and embedded code; validate the MIT grant/copyright material for Bun itself (the exact root overview says MIT but does not reproduce the full grant); assemble and provide the corresponding source/modifications and usable relinking materials through an appropriate distribution channel. Upstream root `LICENSE`, `THIRD_PARTY_NOTICES`, `THIRD_PARTY_NOTICES.md` and `THIRD_PARTY_NOTICES.txt` at `bun-v1.4.4` returned 404 when checked. No invented replacement or other-version notice set is presented as an official consolidated notice. The overview lists zstd as BSD-or-GPLv2; retaining that statement does not establish that a GPL alternative was selected. A complete component/target inventory remains necessary to determine any further GPL/LGPL obligations. Packaged artifact contents, runtime source-to-binary equivalence and successful relinking remain unverified.

# Vazirmatn Font

Copyright 2015 The Vazirmatn Project Authors (https://github.com/rastikerdar/vazirmatn)

This Font Software is licensed under the SIL Open Font License, Version 1.1.

SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

# Instrument Sans Font

Bundled in the dashboard for the Agent's font choice (Agent settings → Appearance), from @fontsource-variable/instrument-sans 5.3.0.

Copyright 2022 The Instrument Sans Project Authors (https://github.com/Instrument/instrument-sans) InstrumentSans-Italic[wdth,wght].ttf: Copyright 2022 The Instrument Sans Project Authors (https://github.com/Instrument/instrument-sans)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

# Geist Font

Bundled in the dashboard for the Agent's font choice (Agent settings → Appearance), from @fontsource-variable/geist 5.3.0.

Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font) Geist-Italic[wght].ttf: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

# DM Sans Font

Bundled in the dashboard for the Agent's font choice (Agent settings → Appearance), from @fontsource-variable/dm-sans 5.3.0.

Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts) DMSans-Italic[opsz,wght].ttf: Copyright 2014 The DM Sans Project Authors (https://github.com/googlefonts/dm-fonts)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

# Inter Font

Bundled in the dashboard for the Agent's font choice (Agent settings → Appearance), from @fontsource-variable/inter 5.3.0.

Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

# Figtree Font

Bundled in the dashboard for the Agent's font choice (Agent settings → Appearance), from @fontsource-variable/figtree 5.3.0.

Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree) Figtree-Italic[wght].ttf: Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
