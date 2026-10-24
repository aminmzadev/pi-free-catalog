# Third-party notices

## Pi AI 1.4.0 token estimation helper

`src/ovh-pool-budget.js` includes the token-estimation implementation from
`@earendil-works/pi-ai@1.4.0`, `dist/utils/estimate.js`.
The only executable change is resolving `getSystemMessageText` through Pi's
host-supported compatibility entrypoint instead of the SDK's relative file.
This preserves the existing OVH handoff estimate semantics without requiring an
unvirtualized SDK utility subpath. The source-map comment was removed.

Upstream: https://github.com/earendil-works/pi/tree/v1.4.0/packages/ai

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.