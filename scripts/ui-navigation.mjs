// Routing is both a destination and the toggle for its initially collapsed children.
export async function navigateUI(page, name) {
  const workspace = page.getByRole('navigation', { name: 'Workspace', exact: true });
  if (['Proxies', 'Relays', 'WARP', 'Psiphon'].includes(name)) {
    const routing = workspace.getByRole('button', { name: 'Routing', exact: true });
    if (await routing.getAttribute('aria-expanded') !== 'true') await routing.click();
  }
  const scope = name === 'Settings' ? page.locator('.sidebar-bottom') : workspace;
  const target = scope.getByRole('button', { name, exact: true });
  // Clicking Routing again would collapse its submenu rather than navigate.
  if (await target.getAttribute('aria-current') !== 'page') await target.click();
  await page.getByRole('heading', { name, exact: true, level: 1 }).waitFor();
}
