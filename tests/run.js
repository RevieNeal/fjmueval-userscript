/* 用 jsdom 模拟学校评教页的两种页面，回归测试 v3.0 的核心逻辑 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'FJMU自动评教助手.v3.1.1.user.js'), 'utf8');
const K_STATE = 'MFEVAL3_STATE';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 列表页 ---------------- */
const LIST_HTML = `<!doctype html><html><head><title>学生评教</title></head><body>
<div id="app">
  <div class="course"><div class="name">人体解剖学 张三</div>
    <div class="btn-go" style="background-color: rgb(124, 186, 35);">去填写</div></div>
  <div class="course"><div class="name">生理学 李四</div>
    <div class="btn-go" style="background-color: rgb(124, 186, 35);">去填写</div></div>
  <div class="course"><div class="name">生物化学 王五</div>
    <div class="go-wrap"><div class="btn-go">去填写</div></div></div>
</div>
<script>
  window.__clicks = 0;
  document.querySelectorAll('.btn-go').forEach(function (b) {
    b.addEventListener('click', function () { window.__clicks++; });
  });
</script>
</body></html>`;

/* ---------------- 表单页 ---------------- */
const FORM_HTML = `<!doctype html><html><head><title>教学评价</title></head><body>
<div id="form">
  <div id="scroll_0" class="item"><div>1. 教学态度</div><span class="fscore">30</span><input class="rater_input" type="text"></div>
  <div id="scroll_1" class="item"><div>2. 教学内容</div><span class="fscore">20</span><input class="rater_input" type="text"></div>
  <div id="scroll_2" class="item"><div>3. 教学方法</div><span class="fscore">20</span><input class="rater_input" type="text"></div>
  <div id="scroll_3" class="item"><div>4. 教学效果</div><span class="fscore">15</span><input class="rater_input" type="text"></div>
  <div id="scroll_4" class="item"><div>5. 总体评价</div><span class="fscore">15</span><input class="rater_input" type="text"></div>
  <div id="scroll_5" class="item"><div>6. 意见与建议</div><textarea></textarea></div>
  <button class="submitbtn" id="submit">提交</button>
</div>
<div id="list" style="display:none">
  <div class="course"><div class="name">生理学 李四</div><div class="btn-go">去填写</div></div>
</div>
<div class="weui-dialog" id="dlg" style="display:none">
  <div class="weui-dialog__bd" id="dlgtext">本次评分：0分，请确认提交</div>
  <a class="weui-dialog__btn weui-dialog__btn_primary" id="ok" href="javascript:;">确定</a>
</div>
<script>
  window.__submits = 0; window.__oks = 0;
  document.getElementById('submit').addEventListener('click', function () {
    window.__submits++;
    document.getElementById('dlgtext').textContent = '本次评分：' +
      [].map.call(document.querySelectorAll('.rater_input'), function (i) { return i.value; }).join('+') + '，请确认提交';
    document.getElementById('dlg').style.display = '';
  });
  document.getElementById('ok').addEventListener('click', function () {
    window.__oks++;
    document.getElementById('dlg').style.display = 'none';
    document.getElementById('form').style.display = 'none';
    document.getElementById('list').style.display = '';
  });
</script>
</body></html>`;

function makeDom(html, seedState) {
  const dom = new JSDOM(html, { url: 'https://jxzhpt.webvpn.fjmu.edu.cn/eval/list', runScripts: 'dangerously' });
  if (seedState) {
    dom.window.sessionStorage.setItem(K_STATE, JSON.stringify({ v: seedState, t: Date.now() }));
  }
  dom.window.eval(SRC);
  // 测试里默认关掉随机浮动，保证断言可复现（专门测随机的地方再打开）
  try { dom.window.__MFEVAL__.cfg.randomize = false; } catch (e) {}
  return dom;
}

async function waitUntil(fn, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(200);
  }
  return false;
}

(async function main() {
  /* ===== 测试 1：列表页 ===== */
  console.log('\n[1] 列表页识别、单次点击、点击无效不计为完成');
  {
    const dom = makeDom(LIST_HTML);
    const w = dom.window;
    const api = w.__MFEVAL__;
    ok(!!api, '脚本挂载成功');
    ok(api.DOM.goFillButtons().length === 3, '识别到 3 个「去填写」（嵌套父子只算一次）', api.DOM.goFillButtons().length);
    ok(api.DOM.isListPage() === true && api.DOM.isFormPage() === false, '页面类型判定为 LIST');

    api.actions.startRun();
    await sleep(1200);
    const st1 = api.getState();
    ok(w.__clicks === 1, '点击「去填写」只触发 1 次 click（v2.2 的 simulateRealClick 会触发 3 次）', w.__clicks);
    ok(st1.running === true, '巡航状态已写入存储');
    ok(st1.pending && /解剖/.test(st1.pending.name), '记录 pending 课程名', st1.pending && st1.pending.name);
    ok(st1.pending.pageToken, 'pending 携带页面 token');
    ok(api.buildDiagnostics().includes('脚本判断: LIST'), '诊断信息可生成');
    ok(api.buildDiagnostics().includes('by Neal'), '诊断里带水印');
    ok(api.buildDiagnostics().includes('适用站点'), '诊断里标明适用站点');

    // 按钮点击没有任何反应的场景：不能被误计为"已完成"
    await sleep(6000);
    const st2 = api.getState();
    ok(st2.done === 0, '点击无跳转时不会误记完成数', st2.done);
    ok((st2.skip || []).length >= 1, '无反应的课程被加入跳过名单', (st2.skip || []).length);
    dom.window.close();
  }

  /* ===== 测试 2：表单页（跨页续跑） ===== */
  console.log('\n[2] 表单页自动填写 + 提交 + 弹窗（跨页续跑）');
  {
    const seed = {
      running: true, startedAt: Date.now(), done: 0, fails: 0,
      pending: { sig: 'x', name: '人体解剖学 张三', ts: Date.now(), pageToken: 'p-old' }, skip: []
    };
    const dom = makeDom(FORM_HTML, seed);
    const w = dom.window;
    const api = w.__MFEVAL__;
    ok(api.DOM.isFormPage() === true, '页面类型判定为 FORM');

    const done = await waitUntil(() => api.getState().done === 1, 25000);
    ok(done, '自动续跑后完成计数 +1');

    const vals = [...w.document.querySelectorAll('.rater_input')].map((i) => i.value);
    ok(JSON.stringify(vals) === JSON.stringify(['27', '17', '16', '13', '13.5']), '5 题分值按 90/85/80/85/90% 折算', vals);
    ok(w.__submits === 1, '提交按钮只点 1 次', w.__submits);
    ok(w.__oks === 1, '确认弹窗「确定」只点 1 次（不重复提交）', w.__oks);
    ok(w.document.querySelector('#scroll_5 textarea').value === '', '总分 86.5% 不触发评语填写');

    const before = { s: w.__submits, o: w.__oks };
    await api.actions.stepForm();
    ok(w.__submits === before.s && w.__oks === before.o, '同一页再次运行被「已提交」保护拦住', [w.__submits, w.__oks]);

    // 回到列表页应解除保护，否则所有课程 URL 相同时第二门会被误拦
    api.actions.stepList();
    await sleep(400);
    ok(api.getState().submittedUrl === '', '回到列表页后「已提交」保护自动解除', api.getState().submittedUrl);
    dom.window.close();
  }

  /* ===== 测试 3：低分时自动写评语 ===== */
  console.log('\n[3] 总分偏低时自动填写评语');
  {
    const seed = { running: true, startedAt: Date.now(), done: 0, fails: 0, pending: null, skip: [] };
    const dom = makeDom(FORM_HTML, seed);
    const w = dom.window;
    const api = w.__MFEVAL__;
    api.actions.stop('测试');
    api.cfg.scores = [50, 50, 50, 50, 50];
    api.cfg.autoSubmit = false;
    await api.actions.fillForm();
    const ta = w.document.querySelector('#scroll_5 textarea');
    ok(ta.value.length > 0, '低分时评语框被写入内容', ta.value.slice(0, 20));
    ok(w.__submits === 0, '关闭自动提交后不点提交');
    const vals = [...w.document.querySelectorAll('.rater_input')].map((i) => i.value);
    ok(JSON.stringify(vals) === JSON.stringify(['15', '10', '10', '7.5', '7.5']), '50% 折算正确', vals);
    dom.window.close();
  }

  /* ===== 测试 4：非评教页面 ===== */
  console.log('\n[4] 非评教页面不误判');
  {
    const seed = { running: true, startedAt: Date.now(), done: 0, fails: 2, pending: null, skip: [] };
    const dom = makeDom('<html><body><div>空白页</div></body></html>', seed);
    const api = dom.window.__MFEVAL__;
    api.cfg.maxFails = 3;
    await api.actions.tick();
    const st = api.getState();
    ok(st.running === true, '非评教页面 tick 不崩溃、不误判完成');
    dom.window.close();
  }

  /* ===== 测试 5：单选式评教兜底 ===== */  console.log('\n[5] 单选式评教的兜底勾选');
  {
    const html = `<!doctype html><html><body>
      <div id="scroll_0"><div>1. 教学态度</div>
        <label><input type="radio" name="q1">优</label><label><input type="radio" name="q1">良</label></div>
      <div id="scroll_1"><div>2. 教学内容</div>
        <label><input type="radio" name="q2">优</label><label><input type="radio" name="q2">良</label></div>
      <button class="submitbtn">提交</button></body></html>`;
    const dom = makeDom(html, null);
    const w = dom.window;
    const api = w.__MFEVAL__;
    api.cfg.autoSubmit = false;
    await api.actions.fillForm();
    const checked = [...w.document.querySelectorAll('input[type=radio]')].filter((r) => r.checked);
    ok(checked.length === 2, '两组单选各勾中 1 项', checked.length);
    dom.window.close();
  }

  /* ===== 测试 6：中途停止不会被流程写回 ===== */
  console.log('\n[6] 中途停止后不会被"复活"');
  {
    const seed = { running: true, startedAt: Date.now(), done: 0, fails: 0, pending: null, skip: [] };
    const dom = makeDom(FORM_HTML, seed);
    const api = dom.window.__MFEVAL__;
    const flow = api.actions.stepForm();
    await sleep(900);                 // 此时正在逐题填写
    api.actions.stop('测试停止');
    await flow;
    await sleep(400);
    const st = api.getState();
    ok(st.running === false, '停止后 running 没被异步流程改回 true', st.running);
    ok(dom.window.__submits === 0, '停止后不再继续提交', dom.window.__submits);
    dom.window.close();
  }

  /* ===== 测试 7：SPA 抽屉（新版界面）===== */
  console.log('\n[7] SPA 右侧抽屉：无 .rater_input 也能识别');
  {
    const DRAWER = `<!doctype html><html><head><title>学生评教</title></head><body>
<div id="app"><div class="page">课程列表占位</div></div>
<div id="drawer" class="side-panel">
  <div class="head"><span class="name">洪淑蓉 妇产科</span><span class="save-btn">保存</span></div>
  <div class="q">
    <div class="q-t">1. 你能从老师的讲课和互动中收获到知识、技能？[评分] 30分</div>
    <input class="score-input" placeholder="输入 0 - 30">
    <input type="range" min="0" max="30" class="slider">
  </div>
  <div class="q">
    <div class="q-t">2. 你能感受到老师对你的关心吗？[评分] 20分</div>
    <input class="score-input" placeholder="输入 0 - 20">
    <input type="range" min="0" max="20" class="slider">
  </div>
  <div class="foot"><div class="submit-btn">提交</div></div>
</div></body></html>`;
    const dom = makeDom(DRAWER, null);
    const w = dom.window;
    const api = w.__MFEVAL__;
    const inputs = api.DOM.raterInputs();
    ok(inputs.length === 2, '只认文本输入框，不把 range 滑块当评分框', inputs.length);
    ok(api.DOM.maxOf(inputs[0]) === 30, '从 placeholder「输入 0 - 30」解析满分', api.DOM.maxOf(inputs[0]));
    ok(api.DOM.maxOf(inputs[1]) === 20, '第二题满分 20', api.DOM.maxOf(inputs[1]));
    ok(api.DOM.isFormPage() === true, '抽屉打开时判定为 FORM');
    const sb = api.DOM.submitBtn();
    ok(sb && /提交/.test(sb.textContent), '找到 div 实现的「提交」按钮', sb && sb.outerHTML.slice(0, 60));

    api.cfg.autoSubmit = false;
    await api.actions.fillForm();
    ok(inputs[0].value === '27' && inputs[1].value === '17', '按 90%/85% 折算写入', [inputs[0].value, inputs[1].value]);
    ok(api.buildDiagnostics().includes('可见输入控件'), '诊断包含通用控件清单');
    dom.window.close();
  }

  /* ===== 测试 8：表单在 iframe 里（真实场景）===== */
  console.log('\n[8] 评教表单位于同源 iframe 内');
  {
    const dom = makeDom('<!doctype html><html><body><div id="shell">壳页面</div></body></html>', null);
    const w = dom.window;
    const api = w.__MFEVAL__;
    const f = w.document.createElement('iframe');
    w.document.body.appendChild(f);
    const idoc = f.contentDocument;
    idoc.body.innerHTML =
      '<div id="scroll_0" class="servery"><h4>1. 题目一 <span class="fscore">30分</span></h4>' +
      '<input class="rater_input" type="text" placeholder="输入0 - 30"></div>' +
      '<div id="scroll_1" class="servery"><h4>2. 题目二 <span class="fscore">20分</span></h4>' +
      '<input class="rater_input" type="text" placeholder="输入0 - 20"></div>' +
      '<div class="foot"><div class="submit-btn">提交</div></div>';

    ok(api.DOM.isFormPage() === true, '顶层看不到表单，但能识别 iframe 内的表单');
    const inputs = api.DOM.raterInputs();
    ok(inputs.length === 2, '从 iframe 里取到 2 个评分框', inputs.length);
    ok(inputs[0].ownerDocument === idoc, '取到的是 iframe 文档里的元素');
    ok(api.DOM.maxOf(inputs[0]) === 30 && api.DOM.maxOf(inputs[1]) === 20, 'iframe 内满分解析正确');

    api.cfg.autoSubmit = false;
    await api.actions.fillForm();
    ok(inputs[0].value === '27' && inputs[1].value === '17', '写入 iframe 内的输入框', [inputs[0].value, inputs[1].value]);
    ok(api.buildDiagnostics().includes('iframe →'), '诊断能报告"活动文档在 iframe 内"');
    dom.window.close();
  }

  /* ===== 测试 9：提交按钮延迟可用 + 自定义确认框 ===== */
  console.log('\n[9] 提交按钮 10 秒才可点 + 非 weui 确认框');
  {
    const html = `<!doctype html><html><head><title>评教</title></head><body>
<div id="form">
  <div id="scroll_0" class="servery"><span class="fscore">30分</span><input class="rater_input" type="text" placeholder="输入0 - 30"></div>
  <div id="scroll_1" class="servery"><span class="fscore">20分</span><input class="rater_input" type="text" placeholder="输入0 - 20"></div>
  <button class="submit-btn" id="submit" disabled>提交</button>
</div>
<div id="list" style="display:none"><div class="course"><div class="btn-go">去填写</div></div></div>
<div class="dialog-mask" id="mask" style="display:none">
  <div class="dialog-box">
    <div class="dialog-title">提示</div>
    <div class="dialog-body" id="dlgbody">本次评分：86.5，请确认提交？</div>
    <button class="dialog-cancel">取消</button>
    <button class="dialog-ok" id="ok">确定</button>
  </div>
</div>
<script>
  window.__submits = 0; window.__oks = 0;
  setTimeout(function () { var b = document.getElementById('submit'); if (b) b.disabled = false; }, 1200);
  document.getElementById('submit').addEventListener('click', function () {
    window.__submits++; document.getElementById('mask').style.display = '';
  });
  document.getElementById('ok').addEventListener('click', function () {
    window.__oks++; document.getElementById('mask').style.display = 'none';
    document.getElementById('form').style.display = 'none';
    document.getElementById('list').style.display = '';
  });
</script></body></html>`;
    const dom = makeDom(html, null);
    const w = dom.window;
    const api = w.__MFEVAL__;
    ok(api.DOM.dialogOk() === null, '没弹窗时不会乱点「确定」');
    ok(api.DOM.submitBtn() && api.DOM.submitBtn().disabled === true, '提交按钮初始是禁用的');

    api.cfg.autoSubmit = true;
    api.cfg.submitCooldown = 0;
    const res = await api.actions.submitForm();
    ok(res === true, '等到按钮可点后提交成功', res);
    ok(w.__submits === 1, '提交按钮只点 1 次', w.__submits);
    ok(w.__oks === 1, '自定义弹窗的「确定」只点 1 次', w.__oks);
    ok(api.DOM.isListPage() === true, '提交后回到列表');
    dom.window.close();
  }

  /* ===== 测试 10：绿色按钮兜底识别（列表页文案未知） ===== */
  console.log('\n[10] 列表页按钮文案不是"去填写"时的兜底');
  {
    const html = `<!doctype html><html><body>
<div id="app">
  <div class="card"><div class="name">妇产科学 洪淑蓉</div>
    <div class="go" style="background-color: rgb(124, 186, 35); color: #fff;">评教</div></div>
  <div class="card"><div class="name">内科学 李强</div>
    <div class="go" style="background-color: rgb(124, 186, 35); color: #fff;">前往</div></div>
  <div class="card"><div class="name">外科学 王芳</div>
    <div class="done" style="background-color: rgb(153, 153, 153);">已完成</div></div>
</div></body></html>`;
    const dom = makeDom(html, null);
    const api = dom.window.__MFEVAL__;
    const btns = api.DOM.goFillButtons();
    ok(btns.length === 2, '靠绿色识别出 2 个待评按钮，灰色"已完成"不算', btns.length);
    ok(btns.map((b) => b.textContent.trim()).join(',') === '评教,前往', '文本任意都行', btns.map((b) => b.textContent.trim()));
    ok(api.buildDiagnostics().includes('短文本元素'), '诊断包含短文本元素清单');
    ok(api.buildDiagnostics().includes('最近日志'), '诊断包含最近日志');
    dom.window.close();
  }

  /* ===== 测试 11：SPA 遮挡场景（列表常驻 + 抽屉盖在上面） ===== */
  console.log('\n[11] 打分时列表 DOM 仍常驻，不能被误判成"已回列表"');
  {
    const html = `<!doctype html><html><body>
<div id="list">
  <div class="card"><div class="name">妇产科学 洪淑蓉</div>
    <div class="btn-go" style="background-color: rgb(124, 186, 35); color:#fff;">去填写</div></div>
</div>
<div id="drawer">
  <div class="head"><div class="back" id="back">&lt;</div><span>洪淑蓉 妇产科学</span></div>
  <div id="scroll_0" class="servery"><span class="fscore">30分</span><input class="rater_input" type="text"></div>
  <div id="scroll_1" class="servery"><span class="fscore">20分</span><input class="rater_input" type="text"></div>
  <button class="submit-btn" id="submit">提交</button>
</div>
<div class="dialog-mask" id="mask" style="display:none">
  <div class="dialog-box">
    <div class="dialog-body">本次评分：86.5，请确认提交？</div>
    <button class="dialog-ok" id="ok">确定</button>
  </div>
</div>
<script>
  window.__oks = 0;
  document.getElementById('submit').addEventListener('click', function () {
    document.getElementById('mask').style.display = '';
  });
  document.getElementById('ok').addEventListener('click', function () {
    window.__oks++;
    document.getElementById('mask').style.display = 'none';   // 只关弹窗，抽屉不关
  });
  document.getElementById('back').addEventListener('click', function () {
    document.getElementById('drawer').style.display = 'none';
  });
</script></body></html>`;
    const dom = makeDom(html, null);
    const w = dom.window;
    const api = w.__MFEVAL__;

    ok(api.DOM.goFillButtons().length === 1, '列表按钮在 DOM 里确实还在');
    ok(api.DOM.isFormPage() === true, '抽屉开着，判定为表单页');
    ok(api.DOM.isListPage() === false, '抽屉开着时 isListPage 必须是 false（旧版这里会误判 true）');

    api.cfg.waitAfterSubmit = 900;
    api.cfg.submitCooldown = 0;
    const res = await api.actions.submitForm();
    ok(res === true, '抽屉没自动关时，靠点「返回」兜底并判定成功', res);
    ok(w.__oks === 1, '「确定」只点 1 次');
    ok(w.document.getElementById('drawer').style.display === 'none', '打分抽屉已关闭');
    ok(api.DOM.isListPage() === true, '关闭后正确识别为列表页');
    dom.window.close();
  }

  /* ===== 测试 12：课程名从"课程：xxx"里取 ===== */
  console.log('\n[12] 课程名不能被"类型：期末"这种标签污染');
  {
    const html = `<!doctype html><html><body>
<div class="card">
  <div class="title">理论-2026-2027第一学期期末评教</div>
  <div class="meta">课程：内科学 截止时间：2027-01-31</div>
  <div class="meta">教师：张良基 照片 类型：期末</div>
  <div class="go" style="background-color: rgb(124, 186, 35); color:#fff;">去填写</div>
</div></body></html>`;
    const dom = makeDom(html, null);
    const api = dom.window.__MFEVAL__;
    const btns = api.DOM.goFillButtons();
    ok(btns.length === 1, '识别到 1 个按钮');
    const name = api.DOM.courseName(btns[0]);
    ok(name.includes('内科学'), '课程名取到"内科学"', name);
    ok(name.includes('张良基'), '带上教师名', name);
    ok(!name.includes('类型'), '不包含"类型：期末"这种标签', name);
    dom.window.close();
  }

  /* ===== 测试 13：列表不刷新时靠 doneSigs 去重 ===== */
  console.log('\n[13] 列表页不刷新时不会反复评同一门');
  {
    const html = `<!doctype html><html><body>
<div id="app">
  <div class="card"><div class="name">课程：内科学 教师：张良基</div>
    <div class="go" id="a" style="background-color: rgb(124, 186, 35); color:#fff;">去填写</div></div>
  <div class="card"><div class="name">课程：外科学 教师：庄顺福</div>
    <div class="go" id="b" style="background-color: rgb(124, 186, 35); color:#fff;">去填写</div></div>
</div>
<script>
  window.__clicked = [];
  document.getElementById('a').addEventListener('click', function () { window.__clicked.push('a'); });
  document.getElementById('b').addEventListener('click', function () { window.__clicked.push('b'); });
</script></body></html>`;
    const dom = makeDom(html, null);
    const w = dom.window;
    const api = w.__MFEVAL__;
    const btns = api.DOM.goFillButtons();
    const sigA = api.courseSig(btns[0]);
    const sigB = api.courseSig(btns[1]);
    ok(sigA !== sigB, '两门课签名不同', [sigA, sigB]);

    api.cfg.waitFormAppear = 100;
    api.saveState(Object.assign(api.getState(), { running: true, doneSigs: [sigA], pending: null, skip: [] }));
    await api.actions.stepList();
    ok(w.__clicked.join(',') === 'b', '已提交的「内科学」被跳过，点了「外科学」', w.__clicked);

    api.saveState(Object.assign(api.getState(), { doneSigs: [sigA, sigB], pending: null }));
    await api.actions.stepList();
    ok(api.getState().running === false, '全部处理完后自动结束巡航', api.getState().running);
    dom.window.close();
  }

  /* ===== 测试 14：弹窗里「取消」在前时，必须点「确定」 ===== */
  console.log('\n[14] Element 弹窗按钮顺序：「取消」在前也不能点错');
  {
    const html = `<!doctype html><html><body>
<button class="submitbtn el-button el-button--primary" id="submit">提交</button>
<div class="el-message-box__wrapper" id="wrap" style="display:none">
  <div class="el-message-box">
    <div class="el-message-box__content">本次评分：88.0，请确认提交？</div>
    <div class="el-message-box__btns">
      <button class="el-button" id="cancel">取消</button>
      <button class="el-button el-button--primary" id="ok">确定</button>
    </div>
  </div>
</div></body></html>`;
    const dom = makeDom(html, null);
    const w = dom.window;
    const api = w.__MFEVAL__;

    ok(api.DOM.dialogOk() === null, '弹窗没出现时，绝不能把表单的「提交」按钮当成「确定」');
    w.document.getElementById('wrap').style.display = '';
    const btn = api.DOM.dialogOk();
    ok(!!btn, '弹窗出现后能找到确认按钮');
    ok(btn && btn.id === 'ok', '点的是「确定」而不是「取消」', btn && (btn.id || btn.textContent));
    dom.window.close();
  }

  /* ===== 测试 15：随机浮动约束 ===== */
  console.log('\n[15] 随机浮动：总分 (84,95)、单项 ≥ 满分 60%');
  {
    const dom = makeDom('<!doctype html><html><body><div>空</div></body></html>', null);
    const api = dom.window.__MFEVAL__;
    const maxes = [30, 20, 20, 15, 15];
    const N = 500;
    let minTotal = 999, maxTotal = 0, badRange = 0, badFloor = 0;
    const seen = new Set();

    for (let i = 0; i < N; i++) {
      const p = api.generateScores(maxes);
      const t = p.total;
      if (!(t > 84 && t < 95)) badRange++;
      p.scores.forEach((s, k) => {
        if (s < maxes[k] * 0.6 - 1e-9 || s > maxes[k] + 1e-9) badFloor++;
      });
      minTotal = Math.min(minTotal, t);
      maxTotal = Math.max(maxTotal, t);
      seen.add(p.scores.join('/'));
    }
    ok(badRange === 0, N + ' 次总分全部落在 (84,95) 开区间', badRange);
    ok(badFloor === 0, N + ' 次单项全部 ≥ 满分 60% 且不超满分', badFloor);
    ok(seen.size > 100, '分数确实在变（组合数 ' + seen.size + '）', seen.size);
    ok(maxTotal - minTotal > 5, '分布有实际跨度（' + minTotal + '~' + maxTotal + '）', Math.round(maxTotal - minTotal));
    dom.window.close();

    // 真正走一遍填表，确认写入页面的总分也在区间内
    const dom2 = makeDom(FORM_HTML, null);
    const api2 = dom2.window.__MFEVAL__;
    api2.cfg.randomize = true;
    api2.cfg.autoSubmit = false;
    await api2.actions.fillForm();
    const vals = [...dom2.window.document.querySelectorAll('.rater_input')].map((e) => parseFloat(e.value));
    const sum = vals.reduce((a, b) => a + b, 0);
    ok(sum > 84 && sum < 95, '实际填表后的总分也在 (84,95) 内（' + sum + '）', sum);
    ok(vals.every((v, i) => v >= [30, 20, 20, 15, 15][i] * 0.6), '实际写入的每项都不低于 60%', vals);
    dom2.window.close();
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
