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
- Bun (the runtime that runs the gateway, bundled in the Windows app and the Linux packages and used by the Docker image) is MIT-licensed and statically links JavaScriptCore, which is LGPL-2.0 licensed. Bun's source and license texts are published with each release at https://github.com/oven-sh/bun.
- React and React DOM (dashboard) are MIT-licensed. Lucide icons (dashboard) are ISC-licensed. Electron (Windows app) is MIT-licensed; its own notices ship inside the app.
- The WARP helper is a build of usque v4.2.1 (https://github.com/Diniboy1123/usque), copyright (c) 2025 Diniboy1123, under the MIT license reproduced at resources/warp/LICENSE. Polygate bundles the built helper and ships the exact local patch at resources/warp/usque.patch. The patch points registration at `api.devices.cloudflare.com`, fragments the first part of the TLS ClientHello on networks that reset it, and enables HTTP/2 keepalive so idle tunnels stay up. The helper runs as a separate process; no usque code is linked into Polygate.
- npm dependencies used to build the dashboard and the Windows app are under their own licenses; run `npm ls` for the list.
