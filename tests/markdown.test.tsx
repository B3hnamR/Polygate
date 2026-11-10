import {test,expect} from 'bun:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {Markdown} from '../src/markdown';

test('replies render tables, linked labels, quotes and inline formatting instead of raw syntax',()=>{
  const html=renderToStaticMarkup(<Markdown text={'## Account check\n\n| Item | Result |\n|---|---|\n| Workspace | **ready** |\n| Path | `C:\\work` |\n\nRead [Acceptable Use terms](https://example.com/terms#use).\n\n> **Quoted policy**\n> Second line.'}/>);
  expect(html).toContain('<table>');expect(html).toContain('<thead>');expect(html).toContain('<strong>ready</strong>');
  expect(html).toContain('href="https://example.com/terms#use"');expect(html).toContain('rel="noopener noreferrer"');expect(html).toContain('<blockquote');expect(html).not.toContain('|---|');
});
test('Markdown cannot inject HTML, scripts or unsafe links; code stays LTR and Persian blocks stay automatic',()=>{
  const html=renderToStaticMarkup(<Markdown text={'<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [credentials](https://user:password@example.com/)\n\nسلام\n\n```html\n<script>alert(1)</script>\n```'}/>);
  expect(html).not.toContain('<img');expect(html).not.toContain('<script>');expect(html).not.toContain('href=');expect(html).toContain('dir="ltr"');expect(html).toContain('dir="auto"');expect(html).toContain('&lt;script&gt;');
});
test('compact model table delimiters and fenced one-line links render with dedicated copy controls',()=>{
  const html=renderToStaticMarkup(<Markdown text={'| Feature | One | Two |\n|-|-|-|\n| Runtime | Container | Function |\n\n```text\nvless://example-test-link\n```'}/>);
  expect(html).toContain('<table>');expect(html).toContain('aria-label="Copy code"');expect(html).toContain('vless://example-test-link');
});
test('local Markdown file references are compact copyable labels, not executable links or raw URL text',()=>{
  const html=renderToStaticMarkup(<Markdown text={'Full findings: [`REPORT.md`](file:///C:/Users/Test/My%20Project/REPORT.md).\n\n[`OTHER.md`]\n(file:///C:/work/OTHER.md)'}/>);
  expect(html).toContain('Copy path for REPORT.md');expect(html).toContain('C:/Users/Test/My Project/REPORT.md');expect(html).toContain('Copy path for OTHER.md');expect(html).not.toContain('href=');expect(html).not.toContain('file:///');
  const invalid=renderToStaticMarkup(<Markdown text={'[remote](file://server/share/file.md) [bad](file:///C:/%00bad)'}/>);expect(invalid).not.toContain('md-local-file');
});
