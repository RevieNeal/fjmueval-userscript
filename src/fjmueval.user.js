// ==UserScript==
// @name         FJMU自动评教助手 v3
// @namespace    https://github.com/RevieNeal/fjmueval-userscript
// @version      3.1.1
// @description  仅适用于福建医科大学评教系统 https://jxzhpt.webvpn.fjmu.edu.cn/static/home/ —— 自动识别列表页/表单页（含 SPA 抽屉），跨页面自动巡航：点「去填写」→ 填分（可随机浮动）→ 提交 → 确认弹窗 → 回列表继续；可停止、可只填不交
// @author       Neal
// @copyright    Neal
// @license      MIT
// @original-author   deepseek+lzy, p1nappollo
// @original-license  none（原作者未声明许可证，版权归原作者所有）
// @original-script   https://scriptcat.org/zh-CN/script-show-page/5233
// @homepage     https://github.com/RevieNeal/fjmueval-userscript
// @supportURL   https://github.com/RevieNeal/fjmueval-userscript/issues
// @source       https://github.com/RevieNeal/fjmueval-userscript
// @match        *://*.jxzhpt.webvpn.fjmu.edu.cn/*
// @match        *://jxzhpt.webvpn.fjmu.edu.cn/*
// @match        *://*.jxzhpt.fjmu.edu.cn/*
// @match        *://jxzhpt.fjmu.edu.cn/*
// @match        *://*.webvpn.fjmu.edu.cn/*
// @match        *://webvpn.fjmu.edu.cn/*
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
 * ============================================================
 *  水印 / 署名：Neal
 * ============================================================
 *
 *  适用范围（重要）
 *  ----------------
 *  本脚本**只适用于**福建医科大学评教系统：
 *      https://jxzhpt.webvpn.fjmu.edu.cn/static/home/
 *  表单所在的 iframe 为 /static/vue/vue/#/survery/... 同源页面。
 *  换到其它域名、其它教务系统、或路径结构变动后，选择器将不再匹配，
 *  脚本可能完全不工作（此时请用面板上的「诊断 / 导出」取结构再适配）。
 *
 * 与 v2.2 的核心差异
 * ----------------
 * 1. v2.2 用 while 循环在一个页面的 JS 上下文里跑完所有课程。点「去填写」整页跳转后
 *    脚本上下文被销毁，循环直接消失 —— 这就是"只能评第一门"的根因。
 *    v3 改成"跨页面状态机"：状态写入 GM/sessionStorage，每张页面加载后读回状态继续巡航。
 * 2. 弹窗确认由多个事件叠加点击改为严格单击（v2.2 的 simulateRealClick 会点 3 次，
 *    存在重复提交风险）。
 * 3. 增加运行上限、连续失败熔断、重复提交保护、"本页已提交"去重。
 * 4. 选择器全部改为多路兜底 + 可见性过滤，并对表单页/列表页做显式识别。
 * 5. 增加「诊断」按钮，导出当前页面 DOM 摘要，方便页面改版后重新适配。
 */

(function () {
    'use strict';

    /* ============================================================
     * 0. 常量与默认配置
     * ============================================================ */
    const VERSION = '3.1.1';
    // 水印：署名信息，会出现在面板底部和诊断信息里
    const WATERMARK = 'Neal';
    const TARGET_SITE = 'https://jxzhpt.webvpn.fjmu.edu.cn/static/home/';
    const K_CFG = 'MFEVAL3_CFG';
    const K_STATE = 'MFEVAL3_STATE';
    const K_LOG = 'MFEVAL3_LOG';
    const PANEL_ID = 'mf-panel';

    const DEFAULT_CFG = {
        // 每题的得分百分比；题目多于 5 道时，第 6 题起沿用最后一项
        scores: [90, 85, 80, 85, 90],
        // 得分取整精度：1 / 0.5 / 0.1 / 0（0 表示不取整，保留两位）
        precision: 0.5,
        // 随机浮动：在上面这条基准线上抖动，总分落在 (randMin, randMax)，单项不低于满分 60%
        randomize: true,
        randMin: 84,
        randMax: 95,
        autoSubmit: true,
        alwaysText: false,      // 勾选则无论总分多少都填写评语
        text: '老师教学认真负责，讲解清晰，课程内容丰富，受益匪浅。',
        safeDelay: true,        // 每步加随机延迟，降低被判定为脚本的概率
        maxCourses: 120,        // 单次巡航最多处理多少门
        maxFails: 3,            // 连续失败几次后熔断
        maxRunMs: 40 * 60 * 1000,
        submitCooldown: 6000,   // 进表单后先等冷却再点提交（实测约 5 秒，取 6 秒留余量）
        waitSubmitBtn: 22000,   // 等「提交」变可点
        waitAfterSubmit: 3000,  // 点「确定」后等打分界面自己关（本校不会，关了再点返回）
        collapsed: false,
        panelPos: null,         // {left, top}
        // 若某页评教改成"单选选项"形式（无 .rater_input），兜底点击第几个选项（1 起）
        radioIndex: 1
    };

    /* ============================================================
     * 1. 存储（GM 优先，退回 sessionStorage；带过期时间）
     * ============================================================ */
    const HAS_GM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

    function kget(key, dflt) {
        try {
            let raw = HAS_GM ? GM_getValue(key, null) : sessionStorage.getItem(key);
            if (raw == null) return dflt;
            if (typeof raw === 'string') raw = JSON.parse(raw);
            if (raw && typeof raw === 'object' && 'v' in raw && 't' in raw) {
                if (Date.now() - raw.t > 6 * 3600 * 1000) return dflt;
                return raw.v;
            }
            return raw;
        } catch (e) { return dflt; }
    }
    function kset(key, value) {
        try {
            const raw = JSON.stringify({ v: value, t: Date.now() });
            if (HAS_GM) GM_setValue(key, raw); else sessionStorage.setItem(key, raw);
        } catch (e) { /* 隐私模式等场景静默失败 */ }
    }

    const cfg = (function () {
        const CFG_SCHEMA = 6;
        const stored = kget(K_CFG, {}) || {};
        if (stored.__schema !== CFG_SCHEMA) {
            // 配置结构升级：作废旧版本残留的调优参数（门数上限、等待时间等）
            ['maxCourses', 'maxRunMs', 'maxFails', 'waitSubmitBtn', 'waitAfterSubmit', 'submitCooldown']
                .forEach((k) => { delete stored[k]; });
            stored.__schema = CFG_SCHEMA;
        }
        return Object.assign({}, DEFAULT_CFG, stored);
    })();
    if (!Array.isArray(cfg.scores) || cfg.scores.length === 0) cfg.scores = DEFAULT_CFG.scores.slice();
    function saveCfg() { kset(K_CFG, cfg); }

    function getState() {
        return Object.assign({
            running: false,
            startedAt: 0,
            done: 0,
            fails: 0,
            pending: null,      // {sig, name, ts}
            skip: [],           // 点了没反应的课程签名
            doneSigs: [],       // 已提交成功的课程签名（列表不刷新时靠它去重）
            submittedUrl: '',   // 本页已提交过的 URL
            submittedAt: 0,
            filledUrl: '',      // 自动提交关闭时，本页已填完的 URL
            emptyTicks: 0,
            note: ''
        }, kget(K_STATE, {}));
    }
    function saveState(s) { kset(K_STATE, s); }

    /* ============================================================
     * 2. 通用小工具
     * ============================================================ */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function waitFor(fn, timeout = 8000, interval = 200) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            try { const v = fn(); if (v) return v; } catch (e) { /* ignore */ }
            await sleep(interval);
        }
        return null;
    }

    const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

    function textOf(el) {
        if (!el) return '';
        return clean(el.innerText || el.textContent || '');
    }

    // jsdom / 无布局环境下 getBoundingClientRect 恒为 0，需要区分"真隐藏"和"无布局"
    let LAYOUT_OK = null;
    function layoutAvailable() {
        if (LAYOUT_OK !== null) return LAYOUT_OK;
        try {
            const d = document.createElement('div');
            d.style.cssText = 'position:absolute;left:-9999px;top:0;width:10px;height:10px';
            document.body.appendChild(d);
            const r = d.getBoundingClientRect();
            d.remove();
            LAYOUT_OK = r.width > 0 && r.height > 0;
        } catch (e) { LAYOUT_OK = false; }
        return LAYOUT_OK;
    }

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        if (el.hidden) return false;
        const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        let n = el;
        for (let depth = 0; n && n.nodeType === 1 && depth < 12; depth++, n = n.parentElement) {
            const cs = win.getComputedStyle(n);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
            if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return false;
        }
        if (layoutAvailable()) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
        }
        return true;
    }

    // 严格单击：只触发一次 click，绝不叠加多套事件
    function clickOnce(el) {
        if (!el) return false;
        try {
            if (typeof el.click === 'function') { el.click(); return true; }
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
        } catch (e) { return false; }
    }

    // 按钮是否不可用：disabled 属性 / 禁用 class / pointer-events:none 都要认
    function isBtnDisabled(el) {
        if (!el) return true;
        if (el.disabled === true) return true;
        if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
        const cls = String(el.className || '');
        if (/disabled|is-disabled|btn-disabled|u-disabled/i.test(cls)) return true;
        try {
            const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
            const cs = win.getComputedStyle(el);
            if (cs.pointerEvents === 'none') return true;
        } catch (e) { /* ignore */ }
        return false;
    }

    // 本校按钮是 #7cba23 系亮绿色，用它做不依赖文案的兜底识别
    function isGreenBtn(el) {
        try {
            const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
            const bg = win.getComputedStyle(el).backgroundColor || '';
            const m = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
            if (!m) return false;
            const r = +m[1], g = +m[2], b = +m[3];
            return g > 110 && g > r + 25 && g > b + 25;
        } catch (e) { return false; }
    }

    // 判断一个元素是否处在浮层（弹窗/提示框）里
    function inFloatingLayer(el) {
        const doc = el.ownerDocument || document;
        const win = doc.defaultView || window;
        let n = el;
        for (let i = 0; i < 10 && n && n.nodeType === 1; i++, n = n.parentElement) {
            const cls = String(n.className || '');
            if (/dialog|modal|popup|message-box|confirm|alert|tip-box|mask|overlay/i.test(cls)) return true;
            try {
                const cs = win.getComputedStyle(n);
                if (cs.position === 'fixed' && (parseInt(cs.zIndex, 10) || 0) >= 100) return true;
            } catch (e) { /* ignore */ }
        }
        // 兜底：页面上有可见的固定定位遮罩
        for (const m of doc.querySelectorAll('[class*="mask"],[class*="overlay"],[class*="backdrop"]')) {
            if (!isVisible(m)) continue;
            try {
                if (win.getComputedStyle(m).position === 'fixed') return true;
            } catch (e) { /* ignore */ }
        }
        return false;
    }

    // 取弹窗里的提示文字，写进日志方便排查
    function dialogText(el) {
        let n = el;
        for (let i = 0; i < 6 && n && n.parentElement; i++) {
            n = n.parentElement;
            const t = clean(n.textContent);
            if (t.length > 12) return t.slice(0, 120);
        }
        return '';
    }

    // 页面上可见的 toast / 提示条文字
    function findToastText() {
        const d = evalDoc();
        for (const el of d.querySelectorAll('[class*="toast"],[class*="message"],[class*="tip"],[class*="notice"],[class*="alert"],[class*="layer"]')) {
            if (!sameOriginNode(el) || !isVisible(el)) continue;
            const t = textOf(el);
            if (t && t.length > 1 && t.length <= 60) return t;
        }
        return '';
    }

    // 绕过 React/Vue 的值劫持，让框架的 input 事件能拿到新值
    function nativeSetValue(el, value) {
        const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        try {
            const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
            if (desc && desc.set) desc.set.call(el, value); else el.value = value;
        } catch (e) { el.value = value; }
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
        el.dispatchEvent(new win.Event('change', { bubbles: true }));
        el.dispatchEvent(new win.Event('blur', { bubbles: false }));
    }

    function roundTo(n, p) {
        if (!p) return Number(n.toFixed(2));
        const r = Math.round(n / p) * p;
        return Number(r.toFixed(4));
    }

    function sameOriginNode(el) {
        return el && !el.closest('#' + PANEL_ID);
    }

    /* --- 活动文档解析 -------------------------------------------------
     * 新版评教把表单塞在同源 iframe 里（/static/vue/vue/#/survery/...），
     * 顶层 document 里一个输入框都没有。同源就能直接拿到 iframe 的
     * document 来操作，于是脚本仍然只有一个实例：
     * 面板挂在顶层，读写都落在 iframe 里。
     */
    let docCache = null;

    function evalDoc() {
        try {
            if (document.querySelector('.rater_input, .submitbtn, #scroll_0')) { docCache = document; return document; }
        } catch (e) { /* ignore */ }
        // 已经绑定过的 iframe 还活着就继续用（SPA 内部路由切换不会换 document）
        if (docCache && docCache !== document && docCache.body && docCache.body.isConnected) return docCache;
        for (const f of document.querySelectorAll('iframe,frame')) {
            let d = null;
            try { d = f.contentDocument; } catch (e) { continue; }   // 跨域就跳过
            if (!d || !d.body) continue;
            if (d.querySelector('.rater_input, .submitbtn, #scroll_0')) { docCache = d; return d; }
        }
        return document;
    }

    // 当前评教页面的 URL（可能在 iframe 里）
    function curUrl() {
        try {
            const d = evalDoc();
            return (d.defaultView || window).location.href;
        } catch (e) { return location.href; }
    }

    /* ============================================================
     * 3. DOM 适配层（所有与学校页面结构相关的判断都集中在这里）
     * ============================================================ */
    const GO_FILL_TEXTS = ['去填写', '去评价', '去评教', '开始评教', '去填写评语'];
    const SUBMIT_TEXTS = ['提交', '提交评价', '提交评教', '保存并提交', '确认提交'];
    const BACK_TEXTS = ['返回列表', '返回', '回列表', '评教完成', '完成', '返回首页'];

    let goCache = { doc: null, t: 0, list: null };

    const DOM = {
        // 列表页的「去填写」按钮
        // 一页可能有好几十门课，全量扫描 + getComputedStyle 比较重，加 800ms 缓存
        goFillButtons() {
            const d = evalDoc();
            const now = Date.now();
            if (goCache.doc === d && now - goCache.t < 800 && goCache.list) return goCache.list.slice();

            const hit = new Set();
            const all = d.querySelectorAll('div,span,a,button,li');
            for (const el of all) {
                if (!sameOriginNode(el)) continue;
                if (!isVisible(el)) continue;
                const t = textOf(el);
                if (!GO_FILL_TEXTS.includes(t)) continue;
                // 只保留最内层命中节点，避免父子同名导致同一门课被点两次
                if ([...el.children].some((c) => GO_FILL_TEXTS.includes(textOf(c)))) continue;
                hit.add(el);
            }
            // 兜底：绿色小按钮（本校的「去填写」和「提交」都是 #7cba23 系绿色）
            if (hit.size === 0) {
                for (const el of d.querySelectorAll('div,span,a,button,li')) {
                    if (!sameOriginNode(el) || !isVisible(el)) continue;
                    const t = textOf(el);
                    if (!t || t.length > 8) continue;
                    if (/提交|保存|取消|确定|确认|返回/.test(t)) continue;
                    if (el.querySelector('input,textarea')) continue;
                    // 只取最内层，避免父子同名重复
                    if ([...el.children].some((c) => textOf(c) === t)) continue;
                    if (!isGreenBtn(el)) continue;
                    hit.add(el);
                }
            }
            const list = [...hit].sort((a, b) =>
                a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
            goCache = { doc: d, t: now, list };
            return list.slice();
        },

        // 列表页 = 有「去填写」按钮，且当前没有打开打分表单。
        // 本校是 SPA：打开打分抽屉时列表 DOM 并不会消失，只是被盖住，
        // 所以必须靠 !isFormPage() 互斥，否则会误判"已经回到列表"。
        isListPage() { return !this.isFormPage() && this.goFillButtons().length > 0; },

        // 评分输入框。优先用旧版结构 .rater_input；
        // 新版（SPA 抽屉）是普通 input + 滑块，靠 placeholder「输入 0 - 30」或 max 属性兜底识别
        raterInputs() {
            const d = evalDoc();
            const native = [...d.querySelectorAll('.rater_input')]
                .filter((el) => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
                .filter(sameOriginNode);
            if (native.length) {
                return native.sort((a, b) =>
                    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
            }
            const loose = [...d.querySelectorAll('input')].filter((el) => {
                if (!sameOriginNode(el) || !isVisible(el)) return false;
                const type = (el.type || 'text').toLowerCase();
                if (['text', 'number', 'tel'].indexOf(type) === -1) return false;
                const ph = el.placeholder || '';
                if (/搜索|search|姓名|账号|密码|学号/i.test(ph)) return false;
                return /0\s*[-~到]\s*\d+/.test(ph) || Number(el.max) > 0 || el.dataset.max != null;
            });
            // 少于 2 个不当成评分表，避免把搜索框之类误判成表单
            return loose.length >= 2 ? loose : [];
        },

        submitBtn() {
            const d = evalDoc();
            const exact = d.querySelector('button.submitbtn, .submitbtn');
            if (exact && isVisible(exact) && sameOriginNode(exact)) return exact;
            let loose = null;
            for (const el of d.querySelectorAll('button,a,div,span,[role=button],uni-button')) {
                if (!sameOriginNode(el) || !isVisible(el)) continue;
                const t = textOf(el);
                if (!SUBMIT_TEXTS.includes(t)) continue;
                // 取最内层命中，避免点到包着按钮的整块容器
                if ([...el.children].some((c) => SUBMIT_TEXTS.includes(textOf(c)))) continue;
                if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'UNI-BUTTON') return el;
                if (!loose && /btn|button|submit|primary|confirm|green/i.test(String(el.className || ''))) loose = el;
            }
            return loose;
        },

        // 打分界面打开中。抽屉如果只是被 v-show 藏起来，输入框还在 DOM 里但不可见，
        // 所以要额外要求"至少有一个评分框是可见的"
        isFormPage() {
            const inputs = this.raterInputs();
            if (inputs.length && inputs.some((el) => isVisible(el))) return true;
            const btn = this.submitBtn();
            const d = evalDoc();
            if (btn && isVisible(btn) && /评教|评价|打分|教学/.test((d.title || '') + ' ' + textOf(d.body).slice(0, 800))) return true;
            return false;
        },

        // 单题满分：.fscore -> 题干"30分" -> input.max -> placeholder「输入 0 - 30」
        maxOf(input) {
            const block = input.closest('[id^="scroll_"]') || input.closest('.item, .question, li') || input.parentElement;
            if (block) {
                const fs = block.querySelector('.fscore');
                if (fs) {
                    const m = clean(fs.textContent).match(/\d+(\.\d+)?/);
                    if (m) return parseFloat(m[0]);
                }
                const m2 = clean(block.textContent).match(/满分\s*(\d+(?:\.\d+)?)|\/\s*(\d+(?:\.\d+)?)\s*分|（\s*(\d+(?:\.\d+)?)\s*分/);
                if (m2) {
                    const v = parseFloat(m2[1] || m2[2] || m2[3]);
                    if (v > 0) return v;
                }
            }
            const attrs = ['max', 'data-max', 'data-score-max', 'data-maxscore'];
            for (const a of attrs) {
                const v = parseFloat(input.getAttribute && input.getAttribute(a));
                if (v > 0) return v;
            }
            const ph = input.placeholder || '';
            const m3 = ph.match(/(\d+(?:\.\d+)?)\s*[-~到]\s*(\d+(?:\.\d+)?)/);
            if (m3) return parseFloat(m3[2]);
            return 0;
        },

        // 若整页没有数值输入框，尝试单选形式的评教
        radioGroups() {
            const d = evalDoc();
            const radios = [...d.querySelectorAll('input[type="radio"]')].filter(sameOriginNode);
            const groups = new Map();
            for (const r of radios) {
                const key = r.name || (r.closest('[id^="scroll_"]') || {}).id || 'x' + (r.parentElement ? [...r.parentElement.parentElement.children].indexOf(r.parentElement) : 0);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(r);
            }
            return [...groups.values()].filter((g) => g.length > 0);
        },

        // 确认框的「确定」按钮。
        // 千万不能按"按钮区里的第一个 button"取 —— Element 的弹窗里第一个是「取消」，
        // 点错就是"弹窗关掉了但根本没提交"。只认文本，且必须在按钮区/浮层内。
        dialogOk() {
            const d = evalDoc();
            const OK_TEXTS = ['确定', '确认', '好的', '知道了', 'OK'];
            const isOkText = (t) => OK_TEXTS.indexOf(t) !== -1;

            // 1) 常见组件库的按钮区，按文本挑，绝不猜顺序
            const boxes = d.querySelectorAll(
                '.el-message-box__btns, .weui-dialog__ft, .ant-modal-footer, ' +
                '.van-dialog__footer, .layui-layer-btn, .el-dialog__footer'
            );
            for (const box of boxes) {
                if (!isVisible(box)) continue;
                for (const btn of box.querySelectorAll('button,a')) {
                    if (!isVisible(btn)) continue;
                    const t = textOf(btn);
                    if (!isOkText(t)) continue;
                    return btn;
                }
            }

            // 2) 通用兜底：可见 + 文本精确 + 位于浮层内，取最内层
            for (const el of d.querySelectorAll('button,a,div,span,uni-button,[role=button]')) {
                if (!sameOriginNode(el) || !isVisible(el)) continue;
                const t = textOf(el);
                if (!isOkText(t)) continue;
                if ([...el.children].some((c) => textOf(c) === t)) continue;
                if (inFloatingLayer(el)) return el;
            }
            return null;
        },

        backToList() {
            const d = evalDoc();
            for (const el of d.querySelectorAll('a,button,div')) {
                if (!sameOriginNode(el) || !isVisible(el)) continue;
                const t = textOf(el);
                if (BACK_TEXTS.includes(t) && t.length <= 6) return el;
            }
            return null;
        },

        // 抽屉/详情页顶部的「返回 / 关闭」控件（提交后界面不自动关时用它兜底）
        drawerBack() {
            const d = evalDoc();
            let loose = null;
            for (const el of d.querySelectorAll('i,span,button,a,div')) {
                if (!sameOriginNode(el) || !isVisible(el)) continue;
                const t = textOf(el);
                if (t === '<' || t === '‹' || t === '返回' || t === '关闭' || t === '×' || t === '✕') return el;
                const cls = String(el.className || '');
                if (!loose && el.children.length === 0 &&
                    /(^|\s|-)(back|fanhui|arrow-left|icon-close|close)(\s|$)/i.test(cls)) loose = el;
            }
            return loose;
        },

        // 课程名：列表卡片里一定有"课程：xxx"，优先按它取；
        // 否则会抓到"类型：期末"这种标签，导致 skip 签名撞车
        courseName(btn) {
            let n = btn;
            let fallback = '';
            for (let i = 0; i < 9 && n; i++) {
                n = n.parentElement;
                if (!n) break;
                let t = textOf(n);
                GO_FILL_TEXTS.forEach((k) => { t = t.split(k).join(''); });
                t = clean(t);
                if (!t) continue;
                const mc = t.match(/课程\s*[:：]\s*([^\s|:：]{2,24})/);
                if (mc) {
                    const mt = t.match(/教师\s*[:：]\s*([^\s|]{2,12})/);
                    return clean(mc[1] + (mt ? ' ' + mt[1] : '')).slice(0, 40);
                }
                if (!fallback && t.length >= 4) fallback = t.slice(0, 40);
            }
            return fallback || textOf(btn) || '未命名课程';
        },

        totalRemaining() { return this.goFillButtons().length; }
    };

    /* ============================================================
     * 4. 日志
     * ============================================================ */
    let logs = kget(K_LOG, []);
    if (!Array.isArray(logs)) logs = [];

    function log(msg, type = 'info') {
        const entry = { t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), m: String(msg), k: type };
        logs.unshift(entry);
        if (logs.length > 120) logs = logs.slice(0, 120);
        kset(K_LOG, logs.slice(0, 40));
        renderLog();
        const fn = type === 'error' ? console.error : type === 'warning' ? console.warn : console.log;
        fn('[评教助手] ' + msg);
    }

    function notify(title, body) {
        try {
            if (typeof GM_notification === 'function') {
                GM_notification({ title, text: body, timeout: 6000 });
            }
        } catch (e) { /* ignore */ }
    }

    function renderLog() {
        const box = document.getElementById('mf-log');
        if (!box) return;
        box.textContent = '';
        for (const e of logs.slice(0, 40)) {
            const row = document.createElement('div');
            row.className = 'mf-log-row mf-' + e.k;
            const time = document.createElement('span');
            time.className = 'mf-log-time';
            time.textContent = '[' + e.t + '] ';
            row.appendChild(time);
            row.appendChild(document.createTextNode(e.m));
            box.appendChild(row);
        }
    }

    /* ============================================================
     * 5. 核心动作
     * ============================================================ */
    let busy = false;

    function setStatus(text, tone) {
        const el = document.getElementById('mf-status');
        if (el) {
            el.textContent = text;
            el.dataset.tone = tone || 'normal';
        }
    }

    // 面板上那句随机区间提示
    function updateRandTip() {
        const el = document.getElementById('mf-rand-tip');
        if (!el) return;
        el.textContent = cfg.randomize
            ? '每门在基准线上随机：总分 ' + cfg.randMin + '~' + cfg.randMax + ' 分，单项不低于满分 60%'
            : '';
    }

    function refreshStats() {
        const st = getState();
        const remain = DOM.totalRemaining();
        const done = st.done || 0;
        const pfill = document.getElementById('mf-pfill');
        if (pfill) {
            const total = done + remain;
            pfill.style.width = total > 0 ? Math.min(100, (done / total) * 100) + '%' : '0%';
        }
        const info = document.getElementById('mf-count');
        if (info) info.textContent = '已完成 ' + done + ' 门 · 本页待评 ' + remain + ' 门';
        const startBtn = document.getElementById('mf-start');
        const stopBtn = document.getElementById('mf-stop');
        if (startBtn) startBtn.disabled = !!st.running;
        if (stopBtn) stopBtn.disabled = !st.running;
    }

    function jitter(base) {
        return cfg.safeDelay ? base + Math.random() * 400 : base;
    }

    // 新版界面每题是「输入框 + 滑块」联动。文本框若被框架拦住，
    // 同步推一把同一个题目块里的 range，两种情况都能生效
    function mirrorToRange(input, value) {
        try {
            const box = input.closest('[id^="scroll_"]') || input.parentElement;
            if (!box) return;
            const range = box.querySelector('input[type="range"], input.range-slider-hidden');
            if (!range || range === input) return;
            const win = (range.ownerDocument && range.ownerDocument.defaultView) || window;
            const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(range), 'value');
            if (desc && desc.set) desc.set.call(range, value); else range.value = value;
            range.dispatchEvent(new win.Event('input', { bubbles: true }));
            range.dispatchEvent(new win.Event('change', { bubbles: true }));
        } catch (e) { /* 没有滑块就跳过 */ }
    }

    // ---- 随机浮动 ----
    // 在基准水平线（滑块设置）上抖动，满足两条硬约束：
    //   1) 总分严格落在 (randMin, randMax) 开区间内
    //   2) 单项不低于本题满分的 60%
    // 做法：先定目标总分，按基准比例缩放，再叠加一组"零和"扰动，
    // 最后把取整改造成的偏差补回去；不满足约束就重新生成。
    function generateScores(maxes) {
        const n = maxes.length;
        if (!n) return null;
        const precision = cfg.precision || 0.5;
        const step = precision > 0 ? precision : 0.01;
        const maxTotal = maxes.reduce((a, b) => a + b, 0) || 100;
        const scale = maxTotal / 100;                       // 按百分制换算，满分不是 100 也对
        const lo = (cfg.randMin == null ? 84 : cfg.randMin) * scale;
        const hi = (cfg.randMax == null ? 95 : cfg.randMax) * scale;
        const floorOf = (m) => m * 0.6;

        const base = maxes.map((m, i) =>
            m * ((cfg.scores[Math.min(i, cfg.scores.length - 1)] || 0) / 100));
        const baseTotal = base.reduce((a, b) => a + b, 0) || 1;

        const build = () => {
            // 目标总分留出半个精度的余量，保证严格落在开区间里
            const lowBound = Math.min(lo + step, hi - step);
            const highBound = Math.max(lowBound, hi - step);
            const target = lowBound + Math.random() * (highBound - lowBound);

            // 1) 按基准比例缩放到目标总分
            let raw = base.map((b) => (b * target) / baseTotal);

            // 2) 叠加零和扰动：每项幅度约本题 5%，总和不变
            const amp = 0.05;
            const jit = [];
            let acc = 0;
            for (let i = 0; i < n - 1; i++) {
                const v = (Math.random() * 2 - 1) * maxes[i] * amp;
                jit.push(v);
                acc += v;
            }
            jit.push(-acc);
            raw = raw.map((v, i) => Math.min(maxes[i], Math.max(floorOf(maxes[i]), v + jit[i])));

            // 3) 取整，再把偏差补回去（只往有余量的题上加/减）
            const fin = raw.map((v) => roundTo(v, precision));
            for (let guard = 0; guard < 120; guard++) {
                const sum = fin.reduce((a, b) => a + b, 0);
                const delta = target - sum;
                if (Math.abs(delta) < step * 0.5) break;
                let idx = -1, bestRoom = 0;
                for (let i = 0; i < n; i++) {
                    const room = delta > 0 ? maxes[i] - fin[i] : fin[i] - floorOf(maxes[i]);
                    if (room > bestRoom + 1e-9) { bestRoom = room; idx = i; }
                }
                if (idx < 0) break;
                fin[idx] = roundTo(fin[idx] + Math.sign(delta) * step, precision);
            }
            return fin;
        };

        let scores = null;
        for (let attempt = 0; attempt < 12; attempt++) {
            const s = build();
            const total = s.reduce((a, b) => a + b, 0);
            const inRange = total > lo && total < hi;
            const aboveFloor = s.every((v, i) => v >= floorOf(maxes[i]) - 1e-9 && v <= maxes[i] + 1e-9);
            if (inRange && aboveFloor) { scores = s; break; }
            if (!scores) scores = s;    // 兜底：先用第一份，继续尝试更好的
        }
        return { scores, total: scores.reduce((a, b) => a + b, 0) };
    }

    // ---- 填写表单 ----
    async function fillForm() {
        const inputs = DOM.raterInputs();
        const radios = inputs.length === 0 ? DOM.radioGroups() : [];

        if (inputs.length === 0 && radios.length === 0) {
            log('没找到评分输入框：页面结构可能已改版，请点「诊断」导出结构给我', 'error');
            return { ok: false, total: 0, maxTotal: 0 };
        }

        let total = 0, maxTotal = 0, miss = 0;

        if (inputs.length > 0) {
            const maxes = inputs.map((el) => DOM.maxOf(el) || 100);
            const plan = cfg.randomize ? generateScores(maxes) : null;
            if (plan) {
                log('随机浮动：' + plan.scores.join(' / ') + '，合计 ' + roundTo(plan.total, 0.5),
                    'info');
            }
            for (let i = 0; i < inputs.length; i++) {
                const el = inputs[i];
                const pct = cfg.scores[Math.min(i, cfg.scores.length - 1)];
                const max = maxes[i];
                const target = String(plan
                    ? plan.scores[i]
                    : roundTo((max * pct) / 100, cfg.precision));
                nativeSetValue(el, target);
                mirrorToRange(el, target);
                await sleep(jitter(90));
                const got = parseFloat(el.value);
                total += Number.isFinite(got) ? got : 0;
                maxTotal += max;
                if (String(el.value) !== target) {
                    miss++;
                    log('第' + (i + 1) + '题写入未生效（页面值=' + el.value + '，期望=' + target + '），可能被控件拦截', 'warning');
                }
            }
            const ratio = maxTotal ? Math.round((total / maxTotal) * 100) : 0;
            log('已填写 ' + inputs.length + ' 题，合计 ' + roundTo(total, 0.5) + '/' + maxTotal + ' 分（' + ratio + '%）', 'success');
        } else {
            // 单选兜底：每题点第 radioIndex 个选项
            for (const group of radios) {
                const idx = Math.max(0, Math.min(group.length - 1, (cfg.radioIndex || 1) - 1));
                const opt = group[idx];
                if (opt) {
                    try { opt.click(); } catch (e) { opt.checked = true; }
                    total += 1; maxTotal += 1;
                }
            }
            log('检测到单选式评教，已按"第 ' + (cfg.radioIndex || 1) + ' 个选项"勾选 ' + radios.length + ' 题', 'info');
        }

        if (miss > 0) return { ok: shouldStopOnWriteFail(miss) ? false : true, total, maxTotal, miss };
        await fillTextComment(total, maxTotal);
        return { ok: true, total, maxTotal };
    }

    function shouldStopOnWriteFail(miss) {
        // 一题都没写进去才算失败；个别题被拦住就记录后继续
        return miss >= Math.max(2, Math.floor(DOM.raterInputs().length / 2));
    }

    async function fillTextComment(total, maxTotal) {
        const d = evalDoc();
        const ta = [...d.querySelectorAll('#scroll_5 textarea, textarea')].filter(sameOriginNode)[0];
        if (!ta) return;
        const ratio = maxTotal ? (total / maxTotal) * 100 : 100;
        const need = ratio < 70 || cfg.alwaysText;
        if (!need) return;
        if (clean(ta.value).length > 0 && !cfg.alwaysText) {
            log('评语框已有内容，保持原样', 'info');
            return;
        }
        nativeSetValue(ta, cfg.text);
        await sleep(jitter(80));
        log(ratio < 70 ? '总分偏低，已自动填写评语' : '已填写评语', 'info');
    }

    // ---- 提交 + 确认弹窗 ----
    async function submitForm() {
        const st = getState();
        if (st.submittedUrl === curUrl() && Date.now() - st.submittedAt < 120000) {
            log('本页已经提交过，跳过重复提交', 'warning');
            return true;
        }

        await sleep(jitter(cfg.safeDelay ? 400 : 150));

        // 本校页面进入表单后「提交」有约 5 秒冷却：按钮看着正常，点了不弹窗也不报错。
        // 与其点了再重试，不如先等够时间，少一次无效点击。
        const cooldown = cfg.submitCooldown == null ? 6000 : Number(cfg.submitCooldown);
        if (cooldown > 0) {
            setStatus('等待页面冷却…', 'normal');
            log('等页面冷却 ' + Math.round(cooldown / 1000) + ' 秒再点提交（页面约 5 秒冷却，留 1 秒余量）', 'info');
            await sleep(cooldown);
        }

        const btnWait = cfg.waitSubmitBtn || 22000;
        const btn = await waitFor(() => {
            const b = DOM.submitBtn();
            return b && !isBtnDisabled(b) ? b : null;
        }, btnWait, 300);

        if (!btn) {
            log(DOM.submitBtn() ? '提交按钮 ' + Math.round(btnWait / 1000) + ' 秒内一直不可用（页面倒计时没走完？）' : '没找到提交按钮', 'error');
            return false;
        }

        const url0 = curUrl();
        let dialogEl = null;

        // 点「提交」只是弹确认框，真正的写入在「确定」上，所以重复点提交是安全的。
        // 上面已经等过冷却，这里只做少量保险重试
        const delays = [0, 4000, 6000];
        for (let i = 0; i < delays.length && !dialogEl; i++) {
            if (curUrl() !== url0) { log('页面已跳转，视为提交成功', 'info'); return true; }
            if (delays[i]) {
                setStatus('提交没弹窗，' + Math.round(delays[i] / 1000) + ' 秒后重试…', 'warn');
                log('这次没弹窗，' + Math.round(delays[i] / 1000) + ' 秒后再试', 'info');
                await sleep(delays[i]);
                if (curUrl() !== url0) { log('页面已跳转，视为提交成功', 'info'); return true; }
            }
            log('点击提交（第 ' + (i + 1) + ' 次）…', 'info');
            clickOnce(btn);
            dialogEl = await waitFor(() => DOM.dialogOk(), 4000, 200);
        }

        if (!dialogEl) {
            log('提交后没出现确认框，页面也没跳转 —— 可能提交失败，或者该课程已评过', 'warning');
            return false;
        }

        await sleep(250);
        const tip = dialogText(dialogEl);
        if (tip) log('确认框：' + tip, 'info');

        const okText = textOf(dialogEl) || '确定';
        if (/取消|关闭|返回|放弃/.test(okText)) {
            log('差点点到「' + okText + '」——这不是确认按钮，放弃这次提交', 'error');
            return false;
        }
        clickOnce(dialogEl);
        log('已点确认框「' + okText + '」', 'info');
        log('等待打分界面关闭（最多 ' + Math.round((cfg.waitAfterSubmit || 3000) / 1000) + ' 秒，之后自动点返回）', 'info');
        setStatus('已提交，等待界面关闭…', 'normal');

        // 成功的唯一标准：打分界面真的消失（抽屉关闭 / 路由切走）。
        // 不能拿"列表页有按钮"当标准 —— 本校列表 DOM 一直存在，只是被抽屉盖住
        const waitLimit = cfg.waitAfterSubmit || 3000;
        const t0 = Date.now();
        let left = false, lastSec = 0;
        while (Date.now() - t0 < waitLimit) {
            if (curUrl() !== url0 || !DOM.isFormPage()) { left = true; break; }
            await sleep(300);
            const sec = Math.floor((Date.now() - t0) / 1000);
            if (sec >= lastSec + 3) {
                lastSec = sec;
                log('仍在等打分界面关闭…（' + sec + ' 秒）', 'info');
            }
        }
        if (left) {
            log(curUrl() !== url0 ? '页面已跳转' : '打分界面已关闭', 'success');
            return true;
        }

        // 界面没关：先看看页面给了什么提示
        const toast = findToastText();
        if (toast) log('页面提示：' + toast, 'info');

        const failedHint = /失败|错误|请先|不能|必填|未完成/.test(toast);
        const successHint = /成功|已提交|已保存|提交完成/.test(toast);

        if (successHint && !failedHint) {
            log('页面提示提交成功，按成功处理', 'success');
            const back0 = DOM.drawerBack();
            if (back0) { clickOnce(back0); await sleep(1000); }
            return true;
        }

        // 有些系统提交成功后抽屉不会自动关，手动点一下返回
        if (!failedHint) {
            const back = DOM.drawerBack();
            if (back) {
                log('尝试点抽屉的「返回」关闭打分界面', 'info');
                clickOnce(back);
                await sleep(1500);
                if (!DOM.isFormPage()) { log('打分界面已关闭', 'success'); return true; }
            }
        }

        log('提交后打分界面一直没关闭，请手动确认是否提交成功', 'error');
        return false;
    }

    // ---- 回到列表 ----
    async function backToList() {
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
            if (DOM.isListPage()) return true;
            await sleep(400);
        }
        const back = DOM.backToList();
        if (back) {
            log('点「' + textOf(back) + '」回到列表', 'info');
            clickOnce(back);
            await sleep(1500);
            if (DOM.isListPage()) return true;
        }
        const drawerBack = DOM.drawerBack();
        if (drawerBack) {
            log('点抽屉的「返回」退出打分界面', 'info');
            clickOnce(drawerBack);
            await sleep(1500);
            if (DOM.isListPage()) return true;
        }
        log('没能自动回到列表，请在页面上手动返回一次（巡航状态已保留）', 'warning');
        return false;
    }

    /* ============================================================
     * 6. 状态机
     * ============================================================ */
    function courseSig(btn) {
        const name = DOM.courseName(btn);
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
        return name.slice(0, 12) + '#' + hash;
    }

    // 每一"张页面"一个 token。用来区分"上一次点击后真的跳走了"和"点了没反应"
    const PAGE_TOKEN = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    // 互斥：轮询和手动按钮不能同时操作 DOM
    let acting = false;
    function guarded(fn) {
        return async function () {
            if (acting) { log('已有流程正在进行，忽略本次调用', 'warning'); return; }
            acting = true;
            try { return await fn(); } finally { acting = false; }
        };
    }

    // 增量打补丁：异步流程里绝不能拿旧快照整对象覆写，
    // 否则中途点「停止」会被正在跑的流程把 running:true 写回去
    function patchState(patch) {
        const next = Object.assign(getState(), patch);
        saveState(next);
        return next;
    }

    async function doStepList() {
        // 回到列表页就解除"本页已提交"保护：
        // 有些系统的所有课程表单 URL 完全一样，不解锁会把下一门课也当成重复提交
        if (getState().submittedUrl) patchState({ submittedUrl: '', submittedAt: 0, filledUrl: '' });

        // 判断 pending 的来源：
        //  pageToken 不同 => 点击后整页跳转过了，现在又回到列表，说明这门课处理完了
        //  pageToken 相同 => 本页点的按钮没产生跳转/弹窗，属于无效点击，跳过它
        let st = getState();
        if (st.pending && st.running) {
            if (st.pending.pageToken && st.pending.pageToken !== PAGE_TOKEN &&
                Date.now() - st.pending.ts < 10 * 60 * 1000) {
                const name = st.pending.name || '上一门';
                st = patchState({ done: (st.done || 0) + 1, fails: 0, pending: null });
                log('「' + name + '」已完成，累计 ' + st.done + ' 门', 'success');
            } else if (st.pending.pageToken === PAGE_TOKEN) {
                log('上一次点击没有产生页面变化，把「' + (st.pending.name || '该课程') + '」标记为跳过', 'warning');
                patchState({ skip: [...(st.skip || []), st.pending.sig].slice(-20), pending: null });
            } else {
                patchState({ pending: null });
            }
        }

        const btns = DOM.goFillButtons();
        if (btns.length === 0) {
            const ticks = (getState().emptyTicks || 0) + 1;
            patchState({ emptyTicks: ticks });
            if (ticks >= 2) finish('列表页已经没有待评教的课程了');
            return;
        }
        if (getState().emptyTicks) patchState({ emptyTicks: 0 });

        st = getState();
        if ((st.done || 0) >= cfg.maxCourses) { finish('已达到单次处理上限 ' + cfg.maxCourses + ' 门，先停在这里'); return; }

        // 本校列表页提交后不会自动刷新，「去填写」按钮还在原地，
        // 所以必须自己记住哪些课程已经交过，否则会反复评同一门
        const doneSigs = st.doneSigs || [];
        const target = btns.find((b) => {
            const s = courseSig(b);
            return !st.skip.includes(s) && !doneSigs.includes(s);
        });
        if (!target) {
            finish(doneSigs.length
                ? '列表里的课程都已经处理过了（共 ' + doneSigs.length + ' 门）'
                : '剩下的课程都点不动，已全部跳过');
            return;
        }

        const sig = courseSig(target);
        const name = DOM.courseName(target);
        patchState({ pending: { sig, name, ts: Date.now(), pageToken: PAGE_TOKEN } });

        log('点击「' + name + '」去填写（剩余 ' + btns.filter((b) => !doneSigs.includes(courseSig(b))).length + ' 门）', 'info');
        clickOnce(target);

        // 同一页内弹出表单的情况（非跳转）
        const appeared = await waitFor(() => DOM.isFormPage(), cfg.waitFormAppear || 5000, 250);
        if (!appeared && getState().running) {
            log('等了 ' + Math.round((cfg.waitFormAppear || 5000) / 1000) + ' 秒还没进入表单页，若下一轮仍未跳转就跳过这门', 'warning');
        }
        refreshStats();
    }
    const stepList = guarded(doStepList);

    async function doStepForm() {
        const st = getState();
        if (st.submittedUrl === curUrl() && Date.now() - st.submittedAt < 120000) {
            log('本页已提交，等待返回列表…', 'info');
            await backToList();
            return;
        }
        if (!cfg.autoSubmit && st.filledUrl === curUrl()) {
            setStatus('已填写，等你手动提交', 'warn');
            return;
        }

        const ready = await waitFor(() => DOM.raterInputs().length > 0 || DOM.radioGroups().length > 0 || DOM.submitBtn(), 12000, 250);
        if (!ready) { log('表单页加载超时，没等到评分控件', 'error'); bumpFail(); return; }
        if (!getState().running) return;

        await sleep(jitter(500));
        const res = await fillForm();
        if (!getState().running) return;
        if (!res.ok) { bumpFail(); return; }
        setStatus('已填写 ' + roundTo(res.total, 0.5) + '/' + res.maxTotal + ' 分，准备提交…', 'normal');

        if (!cfg.autoSubmit) {
            patchState({ filledUrl: curUrl() });
            log('已填好，自动提交已关闭 —— 请手动点提交', 'info');
            setStatus('已填写，等你手动提交', 'warn');
            return;
        }

        await sleep(jitter(700));
        if (!getState().running) return;
        const ok = await submitForm();
        if (!ok) {
            // 不要卡死：把这门标记跳过，退回列表继续下一门
            const s0 = getState();
            const skip = s0.pending && s0.pending.sig
                ? [...(s0.skip || []), s0.pending.sig].slice(-20)
                : (s0.skip || []);
            patchState({ skip, pending: null });
            log('这门没提交成功，先跳过它，回去继续下一门', 'warning');
            bumpFail();
            if (!getState().running) return;   // 已熔断
            await backToList();
            return;
        }

        const s2 = getState();
        const curSig = s2.pending && s2.pending.sig ? s2.pending.sig : '';
        const after = patchState({
            submittedUrl: curUrl(),
            submittedAt: Date.now(),
            done: (s2.done || 0) + 1,
            fails: 0,
            pending: null,
            // 记下这门课的签名：列表页不会刷新，下次要靠它跳过
            doneSigs: curSig ? [...(s2.doneSigs || []), curSig].slice(-200) : (s2.doneSigs || [])
        });
        log('提交成功，累计完成 ' + after.done + ' 门' + (curSig ? '（已记录，不会重复评）' : ''), 'success');

        if ((after.done || 0) >= cfg.maxCourses) { finish('已达到单次处理上限'); return; }
        await backToList();
        refreshStats();
    }
    const stepForm = guarded(doStepForm);

    function bumpFail() {
        const st = patchState({ fails: (getState().fails || 0) + 1 });
        if (st.fails >= cfg.maxFails) stop('连续失败 ' + st.fails + ' 次，已自动停止');
        refreshStats();
    }

    async function tick() {
        if (busy) return;
        const st = getState();
        if (!st.running) return;

        const elapsed = Date.now() - (st.startedAt || 0);
        if (elapsed > cfg.maxRunMs) { stop('运行超时，已自动停止'); return; }
        if ((st.done || 0) >= cfg.maxCourses) { finish('已达单次上限'); return; }

        busy = true;
        try {
            if (DOM.isFormPage()) {
                await stepForm();
            } else if (DOM.isListPage()) {
                await stepList();
            } else {
                setStatus('当前页面不是评教页，等待中…', 'warn');
            }
        } catch (e) {
            log('运行中出现异常：' + (e && e.message ? e.message : e), 'error');
            bumpFail();
        } finally {
            busy = false;
            refreshStats();
        }
    }

    let pollTimer = null;
    function ensurePoll() {
        if (pollTimer) return;
        pollTimer = setInterval(tick, 1500);
    }

    /* ============================================================
     * 7. 运行控制
     * ============================================================ */
    function startRun() {
        const st = getState();
        const fresh = {
            running: true,
            startedAt: Date.now(),
            done: 0,
            fails: 0,
            pending: null,
            skip: [],
            doneSigs: [],
            submittedUrl: '',
            submittedAt: 0,
            filledUrl: '',
            emptyTicks: 0
        };
        saveState(Object.assign(st, fresh));
        log('开始巡航（自动提交=' + (cfg.autoSubmit ? '开' : '关') + '）', 'info');
        setStatus('巡航中…', 'ok');
        ensurePoll();
        refreshStats();
        setTimeout(tick, 300);
    }

    function stop(reason) {
        const st = getState();
        st.running = false;
        saveState(st);
        log('已停止：' + (reason || '手动停止'), 'warning');
        setStatus('已停止', 'warn');
        refreshStats();
    }

    function finish(reason) {
        const st = getState();
        st.running = false;
        st.note = reason;
        saveState(st);
        log('任务结束：' + reason, 'success');
        setStatus('全部完成 🎉', 'ok');
        refreshStats();
        notify('自动评教完成', reason + '（共完成 ' + (st.done || 0) + ' 门）');
    }

    /* ============================================================
     * 8. 诊断
     * ============================================================ */
    // 把元素往上爬成 "div.a.b > ul#x > li.c" 这样的路径，方便反推结构
    function pathOf(el, depth) {
        const parts = [];
        let n = el;
        for (let i = 0; i < (depth || 4) && n && n.nodeType === 1; i++) {
            let s = n.tagName.toLowerCase();
            if (n.id) s += '#' + n.id;
            const cls = typeof n.className === 'string' ? n.className.trim() : '';
            if (cls) s += '.' + cls.split(/\s+/).slice(0, 3).join('.');
            parts.unshift(s);
            n = n.parentElement;
        }
        return parts.join(' > ');
    }

    // 万能诊断：不认识页面结构也能反推出选择器
    function buildDiagnostics() {
        const lines = [];
        const P = (s) => lines.push(s == null ? '' : String(s));
        const clip = (el, n) => (el && el.outerHTML ? el.outerHTML.replace(/\s+/g, ' ').slice(0, n) : '(无)');
        const d = evalDoc();

        P('=== FJMU 评教助手 诊断信息 v' + VERSION + ' (by ' + WATERMARK + ') ===');
        P('适用站点: ' + TARGET_SITE);
        P('时间: ' + new Date().toLocaleString('zh-CN'));
        P('顶层 URL : ' + location.href);
        P('活动文档 : ' + (d === document ? '顶层' : 'iframe → ' + (d.defaultView ? d.defaultView.location.href : '?')));
        P('标题: ' + (d.title || document.title));
        P('顶层frame: ' + (window.top === window.self) + '  iframe 数: ' + document.querySelectorAll('iframe').length);
        P('脚本判断: ' + (DOM.isFormPage() ? 'FORM' : DOM.isListPage() ? 'LIST' : 'OTHER'));
        P('视口: ' + innerWidth + 'x' + innerHeight + '  布局可用=' + layoutAvailable());
        P('');

        // 1) 旧版选择器命中情况
        const counts = {
            '去填写按钮': DOM.goFillButtons().length,
            '.rater_input': d.querySelectorAll('.rater_input').length,
            '[id^=scroll_]': d.querySelectorAll('[id^="scroll_"]').length,
            '.fscore': d.querySelectorAll('.fscore').length,
            'button.submitbtn': d.querySelectorAll('button.submitbtn').length,
            'weui 弹窗按钮': d.querySelectorAll('.weui-dialog__btn_primary').length
        };
        P('--- 旧版选择器命中 ---');
        Object.entries(counts).forEach(([k, v]) => P(k + ': ' + v));
        P('');

        // 2) 所有可见输入控件（适配的核心依据）
        const ctrls = [...d.querySelectorAll('input,textarea,select')]
            .filter((el) => sameOriginNode(el) && isVisible(el)).slice(0, 14);
        P('--- 可见输入控件 (' + ctrls.length + ') ---');
        ctrls.forEach((el, i) => {
            const attrs = [];
            ['type', 'max', 'min', 'step', 'value', 'placeholder', 'name', 'id', 'class'].forEach((a) => {
                const v = el.getAttribute && el.getAttribute(a);
                if (v != null && v !== '') attrs.push(a + '="' + v + '"');
            });
            P((i + 1) + ') <' + el.tagName.toLowerCase() + '> ' + attrs.join(' '));
            P('   路径: ' + pathOf(el, 5));
        });
        P('');

        // 3) 第一个"题目块"的完整 HTML
        const firstInput = ctrls.find((el) => el.tagName === 'INPUT');
        if (firstInput) {
            let box = firstInput;
            for (let i = 0; i < 8 && box.parentElement; i++) {
                if (textOf(box).length > 260) break;
                box = box.parentElement;
            }
            P('--- 第一个题目块 HTML ---');
            P(clip(box, 2400));
            P('');
        }

        // 4) 按钮/可点元素
        const KEY = /^(提交|保存|确定|确认|取消|去填写|去评价|开始评教|关闭|评价|已完成|去评教)$/;
        const btns = [];
        for (const el of d.querySelectorAll('button,a,div,span,uni-button,[role=button]')) {
            if (!sameOriginNode(el) || !isVisible(el)) continue;
            const t = textOf(el);
            if (!KEY.test(t)) continue;
            if ([...el.children].some((c) => textOf(c) === t)) continue;
            btns.push(el);
            if (btns.length >= 16) break;
        }
        P('--- 候选按钮 (' + btns.length + ') ---');
        btns.forEach((el, i) => {
            P((i + 1) + ') <' + el.tagName.toLowerCase() + '> class="' + String(el.className || '') + '" text="' + textOf(el) + '"');
            P('   路径: ' + pathOf(el, 4));
        });
        P('');

        // 5) 弹窗 / 浮层
        const dlg = [...d.querySelectorAll('[class*="dialog"],[class*="modal"],[class*="popup"],[class*="toast"]')]
            .filter((el) => sameOriginNode(el) && isVisible(el)).slice(0, 3);
        P('--- 可见弹窗/浮层 (' + dlg.length + ') ---');
        dlg.forEach((el) => P(clip(el, 600)));
        P('');

        // 6) 页面骨架
        P('--- body 骨架（前 2 层） ---');
        const walk = (el, depth) => {
            if (!el || depth > 2 || lines.length > 300) return;
            [...el.children].slice(0, 25).forEach((c) => {
                P('  '.repeat(depth) + '<' + c.tagName.toLowerCase() + '> ' +
                    (typeof c.className === 'string' ? c.className.slice(0, 80) : ''));
                walk(c, depth + 1);
            });
        };
        walk(d.body, 0);

        // 7) 最近日志：卡在哪一步一目了然
        P('');
        P('--- 最近日志（新→旧） ---');
        logs.slice(0, 30).forEach((e) => P('[' + e.t + '] ' + e.m));
        P('');

        // 8) 页面上所有短文本元素：列表页按钮文案不明时靠这个反推
        const shorts = [];
        for (const el of d.querySelectorAll('div,span,a,button,li,i')) {
            if (!sameOriginNode(el) || !isVisible(el)) continue;
            const t = textOf(el);
            if (!t || t.length > 10) continue;
            if ([...el.children].some((c) => textOf(c) === t)) continue;
            shorts.push(el);
            if (shorts.length >= 40) break;
        }
        P('--- 短文本元素 (' + shorts.length + ') ---');
        shorts.forEach((el, i) => {
            P((i + 1) + ') "' + textOf(el) + '"  <' + el.tagName.toLowerCase() + '> class="' +
                String(el.className || '').slice(0, 60) + '"');
            P('   ' + pathOf(el, 3));
        });

        return lines.join('\n');
    }

    async function showDiagnostics() {
        const text = buildDiagnostics();
        console.log(text);
        try {
            await navigator.clipboard.writeText(text);
            log('诊断信息已复制到剪贴板（也打印在控制台）', 'success');
        } catch (e) {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); log('诊断信息已复制到剪贴板', 'success'); }
            catch (e2) { log('复制失败，请从控制台复制', 'warning'); }
            ta.remove();
        }
        setStatus('诊断信息已生成', 'ok');
    }

    /* ============================================================
     * 9. 界面
     * ============================================================ */
    const CSS = `
    #mf-panel{position:fixed;top:72px;right:18px;width:318px;z-index:2147483000;background:#fff;
      border:1px solid #d8e3ea;border-radius:12px;box-shadow:0 12px 32px rgba(11,43,61,.18);
      font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#17272f;overflow:hidden}
    #mf-panel *{box-sizing:border-box}
    #mf-panel .mf-head{display:flex;align-items:center;gap:8px;padding:9px 12px;
      background:linear-gradient(135deg,#0f6d8c,#128fa8);color:#fff;cursor:move;user-select:none}
    #mf-panel .mf-title{flex:1;font-weight:600;font-size:13px}
    #mf-panel .mf-ico{cursor:pointer;opacity:.85;font-size:15px;line-height:1;padding:0 2px}
    #mf-panel .mf-ico:hover{opacity:1}
    #mf-panel .mf-body{padding:10px 12px 12px;max-height:min(72vh,620px);overflow:auto}
    #mf-panel.mf-collapsed .mf-body{display:none}
    #mf-panel .mf-status{font-size:12px;color:#37505c;background:#f2f6f8;border-radius:7px;padding:6px 9px;margin-bottom:8px}
    #mf-panel .mf-status[data-tone="ok"]{background:#e6f6ec;color:#1d7a3c}
    #mf-panel .mf-status[data-tone="warn"]{background:#fff4e5;color:#a35b00}
    #mf-panel .mf-status[data-tone="bad"]{background:#fdeaea;color:#b3261e}
    #mf-panel .mf-progress{height:5px;background:#e9eef1;border-radius:3px;overflow:hidden;margin:0 0 8px}
    #mf-panel .mf-progress-fill{height:100%;width:0;background:linear-gradient(90deg,#128fa8,#31c48d);transition:width .35s}
    #mf-panel .mf-count{font-size:11px;color:#6b8391;margin-bottom:8px}
    #mf-panel .mf-row{display:flex;align-items:center;gap:8px;margin:5px 0}
    #mf-panel .mf-row label{width:44px;font-size:12px;color:#4a6472;flex:none}
    #mf-panel .mf-row input[type=range]{flex:1;accent-color:#128fa8;height:18px}
    #mf-panel .mf-row output{width:40px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;color:#0f6d8c}
    #mf-panel .mf-opts{display:flex;flex-wrap:wrap;gap:10px;margin:9px 0 4px;font-size:12px;color:#37505c}
    #mf-panel .mf-opts label{display:flex;align-items:center;gap:4px;cursor:pointer}
    #mf-panel .mf-rand-tip{font-size:11px;color:#6b8391;margin-top:2px}
    #mf-panel .mf-by{margin-top:8px;padding-top:6px;border-top:1px solid #eef3f6;
      font-size:10.5px;color:#a8b8c2;text-align:right;letter-spacing:.4px;cursor:default}
    #mf-panel .mf-btns{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
    #mf-panel .mf-btn{padding:7px 0;border:1px solid #d3dde3;background:#fff;border-radius:7px;
      font-size:12px;cursor:pointer;color:#17272f;transition:.15s}
    #mf-panel .mf-btn:hover:not(:disabled){border-color:#128fa8;color:#0f6d8c}
    #mf-panel .mf-btn:disabled{opacity:.45;cursor:not-allowed}
    #mf-panel .mf-primary{background:#128fa8;border-color:#128fa8;color:#fff;font-weight:600}
    #mf-panel .mf-primary:hover:not(:disabled){background:#0f6d8c;color:#fff}
    #mf-panel .mf-danger{color:#b3261e;border-color:#f0c4c0}
    #mf-panel .mf-danger:hover:not(:disabled){background:#fdeaea;color:#b3261e}
    #mf-panel .mf-log{margin-top:9px;border-top:1px dashed #dde6ea;padding-top:7px;
      max-height:170px;overflow:auto;font-size:11.5px;line-height:1.45}
    #mf-panel .mf-log-row{padding:2px 0;border-bottom:1px solid #f3f6f8;word-break:break-all}
    #mf-panel .mf-log-time{color:#93a7b2}
    #mf-panel .mf-success{color:#1d7a3c}
    #mf-panel .mf-error{color:#b3261e}
    #mf-panel .mf-warning{color:#a35b00}
    #mf-fab{position:fixed;right:18px;bottom:24px;z-index:2147483000;width:46px;height:46px;border-radius:50%;
      background:linear-gradient(135deg,#0f6d8c,#128fa8);color:#fff;border:none;cursor:pointer;
      box-shadow:0 8px 20px rgba(11,43,61,.28);font-size:19px;display:none;align-items:center;justify-content:center}
    `;

    function addStyle() {
        if (typeof GM_addStyle === 'function') { GM_addStyle(CSS); return; }
        const s = document.createElement('style');
        s.textContent = CSS;
        document.documentElement.appendChild(s);
    }


    function buildPanel() {
        if (document.getElementById(PANEL_ID)) return;
        addStyle();

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        if (cfg.collapsed) panel.classList.add('mf-collapsed');

        const rows = cfg.scores.map((v, i) => `
            <div class="mf-row">
              <label>第${i + 1}题</label>
              <input type="range" min="0" max="100" step="5" data-i="${i}" value="${v}">
              <output data-i="${i}">${v}%</output>
            </div>`).join('');

        panel.innerHTML = `
          <div class="mf-head" id="mf-head">
            <span class="mf-title">🎯 自动评教 v${VERSION}</span>
            <span class="mf-ico" id="mf-min" title="折叠">–</span>
            <span class="mf-ico" id="mf-close" title="隐藏（右下角小鱼图标可唤回）">×</span>
          </div>
          <div class="mf-body">
            <div class="mf-status" id="mf-status">初始化…</div>
            <div class="mf-progress"><div class="mf-progress-fill" id="mf-pfill"></div></div>
            <div class="mf-count" id="mf-count">—</div>
            ${rows}
            <div class="mf-opts">
              <label><input type="checkbox" id="mf-opt-submit"> 自动提交</label>
              <label><input type="checkbox" id="mf-opt-text"> 总是填评语</label>
              <label><input type="checkbox" id="mf-opt-safe"> 安全延迟</label>
              <label title="每门课在基准线上随机浮动，总分落在 ${cfg.randMin}~${cfg.randMax}，单项不低于满分 60%">
                <input type="checkbox" id="mf-opt-rand"> 随机浮动
              </label>
            </div>
            <div class="mf-rand-tip" id="mf-rand-tip"></div>
            <div class="mf-btns">
              <button class="mf-btn mf-primary" id="mf-start">▶ 开始巡航</button>
              <button class="mf-btn mf-danger" id="mf-stop" disabled>■ 停止</button>
              <button class="mf-btn" id="mf-fill">填写当前页</button>
              <button class="mf-btn" id="mf-diag">诊断 / 导出</button>
            </div>
            <div class="mf-log" id="mf-log"></div>
            <div class="mf-by" id="mf-by" title="${TARGET_SITE}">by ${WATERMARK}</div>
          </div>`;

        document.body.appendChild(panel);

        const fab = document.createElement('button');
        fab.id = 'mf-fab';
        fab.textContent = '🐟';
        fab.title = '打开自动评教面板';
        fab.addEventListener('click', () => {
            panel.style.display = '';
            fab.style.display = 'none';
        });
        document.body.appendChild(fab);

        // 折叠 / 关闭
        document.getElementById('mf-min').addEventListener('click', () => {
            panel.classList.toggle('mf-collapsed');
            cfg.collapsed = panel.classList.contains('mf-collapsed');
            saveCfg();
        });
        document.getElementById('mf-close').addEventListener('click', () => {
            panel.style.display = 'none';
            fab.style.display = 'flex';
        });

        // 分数滑块
        panel.querySelectorAll('input[type=range]').forEach((input) => {
            input.addEventListener('input', () => {
                const i = Number(input.dataset.i);
                cfg.scores[i] = Number(input.value);
                const out = panel.querySelector('output[data-i="' + i + '"]');
                if (out) out.textContent = input.value + '%';
                saveCfg();
            });
        });

        // 选项
        const optSubmit = document.getElementById('mf-opt-submit');
        const optText = document.getElementById('mf-opt-text');
        const optSafe = document.getElementById('mf-opt-safe');
        const optRand = document.getElementById('mf-opt-rand');
        optSubmit.checked = cfg.autoSubmit;
        optText.checked = cfg.alwaysText;
        optSafe.checked = cfg.safeDelay;
        optRand.checked = cfg.randomize;
        optSubmit.addEventListener('change', () => { cfg.autoSubmit = optSubmit.checked; saveCfg(); log('自动提交：' + (cfg.autoSubmit ? '开' : '关'), 'info'); });
        optText.addEventListener('change', () => { cfg.alwaysText = optText.checked; saveCfg(); });
        optSafe.addEventListener('change', () => { cfg.safeDelay = optSafe.checked; saveCfg(); });
        optRand.addEventListener('change', () => {
            cfg.randomize = optRand.checked;
            saveCfg();
            updateRandTip();
            log('随机浮动：' + (cfg.randomize ? '开' : '关'), 'info');
        });
        updateRandTip();

        // 按钮
        document.getElementById('mf-start').addEventListener('click', () => startRun());
        document.getElementById('mf-stop').addEventListener('click', () => stop('手动停止'));
        document.getElementById('mf-fill').addEventListener('click', async () => {
            if (!DOM.isFormPage()) { log('当前不是评教表单页，先点「去填写」进入课程', 'warning'); return; }
            if (acting || busy) { log('巡航正在处理这一页，稍等一下', 'warning'); return; }
            const r = await fillForm();
            setStatus(r.ok ? '已填写 ' + r.total + '/' + r.maxTotal + ' 分' : '填写失败', r.ok ? 'ok' : 'bad');
        });
        document.getElementById('mf-diag').addEventListener('click', showDiagnostics);

        makeDraggable(panel);
        if (cfg.panelPos) {
            panel.style.left = cfg.panelPos.left + 'px';
            panel.style.top = cfg.panelPos.top + 'px';
            panel.style.right = 'auto';
        }
        renderLog();
        refreshStats();
    }

    function makeDraggable(panel) {
        const head = panel.querySelector('.mf-head');
        let dragging = false, dx = 0, dy = 0;
        head.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('mf-ico')) return;
            dragging = true;
            const r = panel.getBoundingClientRect();
            dx = e.clientX - r.left;
            dy = e.clientY - r.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const left = Math.max(0, Math.min(innerWidth - panel.offsetWidth, e.clientX - dx));
            const top = Math.max(0, Math.min(innerHeight - 60, e.clientY - dy));
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            cfg.panelPos = { left: parseInt(panel.style.left, 10) || 0, top: parseInt(panel.style.top, 10) || 0 };
            saveCfg();
        });
    }

    /* ============================================================
     * 10. 启动
     * ============================================================ */
    function boot() {
        if (document.getElementById(PANEL_ID)) return;
        buildPanel();

        const where = DOM.isFormPage() ? '表单页' : DOM.isListPage() ? '列表页' : '未知页面';
        const inFrame = evalDoc() !== document;
        log('评教助手 v' + VERSION + ' 已加载（' + where + (inFrame ? ' · iframe 内' : '') + '）', 'info');

        if (typeof GM_registerMenuCommand === 'function') {
            try { GM_registerMenuCommand('显示评教面板', () => { const p = document.getElementById(PANEL_ID); if (p) p.style.display = ''; else buildPanel(); }); } catch (e) { /* ignore */ }
        }

        refreshStats();

        const st = getState();
        if (st.running) {
            // 跨页面 / 跨 iframe 续跑：上一页点完「去填写」跳到这里，接着干
            log('检测到未完成的巡航任务，自动继续（已完成 ' + (st.done || 0) + ' 门）', 'info');
            setStatus('巡航中…', 'ok');
            ensurePoll();
            setTimeout(tick, 800);
        } else {
            setStatus(DOM.isListPage() || DOM.isFormPage() ? '就绪' : '等待进入评教页面', 'normal');
            if (DOM.isListPage()) {
                log('检测到 ' + DOM.totalRemaining() + ' 门待评教课程，点「开始巡航」即可', 'info');
            }
            // 页面可能异步渲染（SPA / iframe），定时刷新统计
            setInterval(refreshStats, 3000);
        }
    }

    function init() {
        if (!document.body) { setTimeout(init, 300); return; }

        if (window.top === window.self) { boot(); return; }

        // 非顶层 frame：正常情况下由顶层实例统一驱动（同源可直接操作 iframe 内 DOM）。
        // 只有当顶层明显没有脚本在跑时，才自己兜底接管，避免一个页面出现两块面板。
        setTimeout(() => {
            let topPanel = null;
            try { topPanel = window.top.document.querySelector('#' + PANEL_ID); } catch (e) { topPanel = null; }
            if (!topPanel) boot();
        }, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }

    // 测试/调试钩子：方便在控制台手动调用和自动化测试，不影响正常使用
    if (typeof window !== 'undefined') {
        window.__MFEVAL__ = { VERSION, cfg, DOM, actions: { fillForm, submitForm, backToList, stepList, stepForm, tick, startRun, stop, finish }, getState, saveState, log, buildDiagnostics, courseSig, generateScores };
    }
})();
