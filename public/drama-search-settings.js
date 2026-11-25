export async function mountSearchSettings(container, api) {
  if (!container) return;
  container.textContent = '正在读取搜索来源…';
  try {
    let settings = await api('/search-settings');
    if (!container.isConnected) return;
    const form = document.createElement('form');
    form.className = 'paper pad flow-form';
    form.innerHTML = '<h2>公开网络搜索来源</h2><p class="small">启用的来源用于获准联网的 Worker。每次搜索会向所选来源发送关键词。</p><fieldset><legend>搜索来源</legend><div class="row wrap"></div></fieldset><label>SearXNG 搜索地址（可选）<input type="url" name="endpoint" placeholder="https://search.example.org/search"></label><p class="small" data-hint></p><div class="row"><button class="btn primary" type="submit">保存搜索设置</button><button class="btn text" type="button" data-reload>重新载入</button></div><p role="status" aria-live="polite"></p>';
    const choices = form.querySelector('fieldset div');
    for (const source of settings.catalog) {
      const label = document.createElement('label');
      label.className = 'option';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'source';
      box.value = source.id;
      box.checked = settings.sources.includes(source.id);
      label.append(box,document.createTextNode(' ' + source.name));
      choices.append(label);
    }
    const endpoint = form.elements.namedItem('endpoint');
    endpoint.value = settings.endpoint;
    form.querySelector('[data-hint]').textContent = settings.bundled
      ? '留空使用本工作台的独立搜索服务。维基百科直连。'
      : '维基百科直连。其他来源需要启用 JSON 查询的公开 HTTPS 搜索服务。';
    form.querySelector('[data-reload]').onclick = () => mountSearchSettings(container,api);
    form.onsubmit = async event => {
      event.preventDefault();
      const save = form.querySelector('[type="submit"]');
      const status = form.querySelector('[role="status"]');
      if (save.disabled) return;
      save.disabled = true;
      try {
        settings = await api('/search-settings',{method:'PUT',body:{
          expectedVersion:settings.version, sources:new FormData(form).getAll('source'), endpoint:endpoint.value.trim(),
        }});
        status.textContent = '已保存，后续搜索采用此配置。';
      } catch (error) { status.textContent = error.message; }
      finally { save.disabled = false; }
    };
    container.replaceChildren(form);
  } catch (error) { container.textContent = error.message; }
}
