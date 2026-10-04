// Trigger builder: a trigger card's "Trigger Pattern(s)" from lists —
// Platform · Channel · Event · Detail — like Theater's Studio.
//
// A trigger is Theater Reader's "Platform channel event detail", e.g.
// "Twitch mortygotvr redeem Hydrate"; a pattern has * for "any". Amounts
// (bits, Super Chats, hype train levels) are never part of it: any amount
// matches, and actions get it as {amount}.
//
// The text box stays the card's pattern(s) (comma-separated); the builder
// shows them as chips (✕ removes one, a click loads it in the lists) and
// adds or changes them. 🎯 Catch next fills the lists from the next alert.
(function () {
    'use strict';

    const PLATFORMS = ['Twitch', 'Kick', 'YouTube'];
    const EVENTS = {
        Twitch: [
            ['redeem', 'Channel points redeem', 'title'],
            ['cheer', 'Cheer (bits)', ' bits'],
            ['sub', 'Sub / resub / gift', null],
            ['raid', 'Raid', null],
            ['hype train', 'Hype train (level)', ''],
            ['ban', 'Ban', null],
            ['timeout', 'Timeout', null],
        ],
        Kick: [
            ['redeem', 'Channel points redeem', 'title'],
            ['follow', 'Follow', null],
            ['sub', 'Sub', null],
            ['gift sub', 'Gifted subs', null],
            ['raid', 'Raid (host)', null],
            ['raid end', 'Raid ended', null],
            ['ban', 'Ban', null],
            ['timeout', 'Timeout', null],
            ['stream start', 'Stream started', null],
            ['stream end', 'Stream ended', null],
        ],
        YouTube: [
            ['super chat', 'Super Chat (amount)', ''],
            ['super sticker', 'Super Sticker (amount)', ''],
            ['member', 'New member', null],
        ],
    };

    // [words, label, detail]: detail 'title' (a redeem's), a string (an
    // amount, then those words), or null (nothing)
    function events(platform) {
        if (platform) return EVENTS[platform] || [];
        const all = [];
        PLATFORMS.forEach(p => EVENTS[p].forEach(e => { if (!all.some(a => a[0] === e[0])) all.push(e); }));
        return all;
    }

    function kindOf(parts) {
        return events(parts.platform).find(e => e[0] === parts.event) || null;
    }

    function platformNamed(name) {
        return PLATFORMS.find(p => p.toLowerCase() === String(name).toLowerCase()) || null;
    }

    const isAny = w => w === '*' || (w.startsWith('{') && w.endsWith('}'));

    // The pattern ('' until an event is chosen)
    function compose(parts) {
        const kind = kindOf(parts);
        if (!kind) return '';
        const channel = (parts.channel || '').trim() || '*';
        let out = `${parts.platform || '*'} ${channel} ${kind[0]}`;
        if (kind[2] === 'title') out += ' ' + ((parts.detail || '').trim() || '*');
        else if (typeof kind[2] === 'string') out += ' *' + kind[2];
        return out;
    }

    // The longest event that starts `rest` ("raid end" over "raid")
    function eventAt(platform, rest) {
        let best = null;
        events(platform).forEach(k => {
            const kw = k[0].split(' ');
            if (rest.length >= kw.length && kw.every((w, i) => w.toLowerCase() === rest[i].toLowerCase())) {
                if (!best || k[0].length > best[0].length) best = k;
            }
        });
        return best;
    }

    // A pattern's parts, when the lists can say it (else null: edit it as text)
    function parse(pattern) {
        const words = String(pattern).trim().split(/\s+/);
        if (words.length < 3) return null;
        let platform = null;
        if (!isAny(words[0])) { platform = platformNamed(words[0]); if (!platform) return null; }
        const channel = isAny(words[1]) ? '' : words[1];
        if (channel.includes('*')) return null;
        const rest = words.slice(2);
        const kind = eventAt(platform, rest);
        if (!kind) return null;
        const detail = rest.slice(kind[0].split(' ').length);
        let title = '';
        if (kind[2] === null) {
            if (detail.length) return null;
        } else if (kind[2] === 'title') {
            if (detail.length === 1 && isAny(detail[0])) title = '';
            else if (!detail.length || detail.some(w => w.includes('*') || isAny(w))) return null;
            else title = detail.join(' ');
        } else {
            const want = ['*'].concat(kind[2].trim().split(/\s+/).filter(Boolean));
            const fits = detail.length === want.length && detail.every((w, i) => want[i] === '*' ? isAny(w) : w.toLowerCase() === want[i]);
            if (!fits) return null;
        }
        return { platform, channel, event: kind[0], detail: title };
    }

    // An alert's trigger ("Twitch mortygotvr cheer 500 bits") in the lists,
    // amount left out: 🎯 Catch next
    function fromEvent(trigger) {
        const words = String(trigger).trim().split(/\s+/);
        if (words.length < 3) return null;
        const platform = platformNamed(words[0]);
        if (!platform) return null;
        const kind = eventAt(platform, words.slice(2));
        if (!kind) return null;
        const detail = words.slice(2 + kind[0].split(' ').length);
        const channel = ['testserver', 'ST', 'System'].includes(words[1]) ? '' : words[1];
        return { platform, channel, event: kind[0], detail: kind[2] === 'title' ? detail.join(' ') : '' };
    }

    // ─── What the lists offer ──────────────────────────────────────────────
    // Channels and redeem titles: Theater's (inside OBS), and those this panel saw
    const seen = {}; // platform → channel → Set(titles)

    function note(platform, channel, title) {
        if (!platform || !channel || ['ST', 'System', 'testserver'].includes(channel)) return;
        const chans = seen[platform] = seen[platform] || {};
        const key = Object.keys(chans).find(k => k.toLowerCase() === channel.toLowerCase()) || channel;
        const titles = chans[key] = chans[key] || new Set();
        if (title && title !== 'Unknown') titles.add(title);
    }

    async function loadTheaterSeen() {
        if (!(window.__TAURI__ && window.__TAURI__.core)) return;
        try {
            const out = await window.__TAURI__.core.invoke('obs_call_proc', { name: 'theater_reader_seen', returns: { json: 'string' } });
            const all = JSON.parse(out.json || '{}');
            Object.entries(all).forEach(([p, chans]) => Object.entries(chans || {}).forEach(([c, titles]) => {
                note(p, c, null);
                (titles || []).forEach(t => note(p, c, t));
            }));
        } catch (e) { /* Theater isn't there */ }
    }

    function channels(platform) {
        const out = [];
        PLATFORMS.filter(p => !platform || p === platform).forEach(p => Object.keys(seen[p] || {}).forEach(c => {
            if (!out.some(o => o.toLowerCase() === c.toLowerCase())) out.push(c);
        }));
        return out.sort((a, b) => a.localeCompare(b));
    }

    function titles(platform, channel) {
        const out = new Set();
        PLATFORMS.filter(p => !platform || p === platform).forEach(p => Object.entries(seen[p] || {}).forEach(([c, set]) => {
            if (!channel || c.toLowerCase() === channel.toLowerCase()) set.forEach(t => out.add(t));
        }));
        return [...out].sort((a, b) => a.localeCompare(b));
    }

    // ─── 🎯 Catch next ─────────────────────────────────────────────────────
    let catcher = null; // (trigger) => void

    // Every Theater Reader message the panel gets (handleReaderMessage)
    function onReaderMessage(data) {
        if (!data || data.type !== 'alert' || !data.trigger) return;
        const parts = fromEvent(data.trigger);
        if (parts && data.source !== 'Test UI') {
            const irc = String(data.event || '').endsWith('(irc)');
            note(parts.platform, parts.channel, irc ? null : parts.detail);
        }
        if (catcher) { const c = catcher; catcher = null; c(data.trigger); }
    }

    // ─── The UI ────────────────────────────────────────────────────────────
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function patternsOf(input) {
        return input.value.split(',').map(s => s.trim()).filter(Boolean);
    }

    function setPatterns(input, list) {
        input.value = list.join(', ');
        // The card saves on input (triggers-container listens)
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function mount(input) {
        if (!input || input.dataset.builder) return;
        input.dataset.builder = '1';
        const box = document.createElement('div');
        box.className = 'tb-box';
        input.insertAdjacentElement('afterend', box);
        const st = { parts: { platform: null, channel: '', event: '', detail: '' }, editing: -1, open: false, status: '', typing: false };

        function render() {
            const list = patternsOf(input);
            const chips = list.map((p, i) => `
                <span class="tb-chip ${st.editing === i ? 'tb-chip-editing' : ''}" data-i="${i}" title="${parse(p) ? 'Change it' : 'Only as text'}">
                    <span class="tb-chip-text">${esc(p)}</span><span class="tb-chip-x" data-x="${i}" title="Remove it">✕</span>
                </span>`).join('');
            const kind = kindOf(st.parts);
            const platformOpts = [['', 'Any']].concat(PLATFORMS.map(p => [p, p]))
                .map(([v, l]) => `<option value="${v}" ${(st.parts.platform || '') === v ? 'selected' : ''}>${l}</option>`).join('');
            const chans = channels(st.parts.platform);
            if (st.parts.channel && !chans.some(c => c.toLowerCase() === st.parts.channel.toLowerCase())) chans.unshift(st.parts.channel);
            const channelOpts = [['', 'Any']].concat(chans.map(c => [c, c])).concat([['__type', '✏ Type one…']])
                .map(([v, l]) => `<option value="${esc(v)}" ${st.parts.channel === v && v !== '__type' ? 'selected' : ''}>${esc(l)}</option>`).join('');
            const eventOpts = [['', 'Choose…']].concat(events(st.parts.platform).map(e => [e[0], e[1]]))
                .map(([v, l]) => `<option value="${esc(v)}" ${st.parts.event === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
            let detail = '';
            if (kind && kind[2] === 'title') {
                const dl = `tb-titles-${Math.random().toString(36).slice(2)}`;
                detail = `<label>Title <input class="tb-title" list="${dl}" value="${esc(st.parts.detail)}" placeholder="any"></label>
                    <datalist id="${dl}">${titles(st.parts.platform, st.parts.channel).map(t => `<option value="${esc(t)}">`).join('')}</datalist>`;
            } else if (kind && typeof kind[2] === 'string') {
                detail = `<span class="tb-weak" title="Amounts never limit a trigger: actions get it as {amount}">any amount → {amount}</span>`;
            }
            const pattern = compose(st.parts);
            const editing = st.editing >= 0 && st.editing < list.length;
            const fresh = !list.some(p => p.toLowerCase() === pattern.toLowerCase());
            box.innerHTML = `
                <div class="tb-chips">${chips || '<span class="tb-weak">No pattern yet.</span>'}
                    <button type="button" class="tb-toggle" title="Build a pattern from lists">${st.open ? '▴ Lists' : '🧩 Lists'}</button></div>
                ${st.open ? `<div class="tb-lists">
                    <label>Platform <select class="tb-platform">${platformOpts}</select></label>
                    <label>Channel ${st.typing
                        ? `<input class="tb-channel-text" value="${esc(st.parts.channel)}" placeholder="channel"><button type="button" class="tb-channel-list" title="Pick from the list">▾</button>`
                        : `<select class="tb-channel">${channelOpts}</select>`}</label>
                    <label>Event <select class="tb-event">${eventOpts}</select></label>
                    ${detail}
                </div>
                <div class="tb-actions">
                    ${pattern ? `<code>${esc(pattern)}</code>` : ''}
                    ${editing
                        ? `<button type="button" class="tb-update" ${pattern ? '' : 'disabled'}>✔ Update</button><button type="button" class="tb-cancel">Cancel</button>`
                        : `<button type="button" class="tb-add" ${pattern && fresh ? '' : 'disabled'}>➕ Add</button>`}
                    <button type="button" class="tb-catch">${catcher && st.catching ? '⏹ Stop' : '🎯 Catch next'}</button>
                    <span class="tb-weak">${esc(st.status)}</span>
                </div>` : ''}`;
        }

        box.addEventListener('click', (e) => {
            const x = e.target.closest('[data-x]');
            if (x) {
                const list = patternsOf(input);
                list.splice(+x.dataset.x, 1);
                st.editing = -1;
                setPatterns(input, list);
                render();
                return;
            }
            const chip = e.target.closest('.tb-chip');
            if (chip) {
                const parts = parse(patternsOf(input)[+chip.dataset.i]);
                if (!parts) { input.focus(); return; }
                st.parts = parts; st.editing = +chip.dataset.i; st.open = true; st.status = ''; st.typing = false;
                render();
                return;
            }
            if (e.target.closest('.tb-toggle')) { st.open = !st.open; render(); return; }
            if (e.target.closest('.tb-channel-list')) { st.typing = false; render(); return; }
            const pattern = compose(st.parts);
            if (e.target.closest('.tb-add') && pattern) {
                setPatterns(input, patternsOf(input).concat([pattern]));
                render();
            } else if (e.target.closest('.tb-update') && pattern) {
                const list = patternsOf(input);
                list[st.editing] = pattern;
                st.editing = -1;
                setPatterns(input, list);
                render();
            } else if (e.target.closest('.tb-cancel')) {
                st.editing = -1; render();
            } else if (e.target.closest('.tb-catch')) {
                if (st.catching) { st.catching = false; catcher = null; st.status = ''; render(); return; }
                st.catching = true;
                st.status = 'Waiting for the next alert… (do the redeem, or test it)';
                catcher = (trigger) => {
                    st.catching = false;
                    const parts = fromEvent(trigger);
                    if (parts) { st.parts = parts; st.typing = false; st.status = `Caught: ${trigger}`; }
                    else st.status = `Caught "${trigger}": the lists don't have it`;
                    if (document.body.contains(box)) render();
                };
                render();
            }
        });
        // The builder's own fields aren't the card's: they don't save it
        const own = (e) => e.target.closest('.tb-lists') && e.stopPropagation();
        box.addEventListener('input', (e) => {
            if (!e.target.closest('.tb-lists')) return;
            e.stopPropagation();
            if (e.target.classList.contains('tb-title') || e.target.classList.contains('tb-channel-text')) {
                if (e.target.classList.contains('tb-title')) st.parts.detail = e.target.value;
                else st.parts.channel = e.target.value.trim();
                const code = box.querySelector('.tb-actions code');
                const pattern = compose(st.parts);
                if (code) code.textContent = pattern;
                const add = box.querySelector('.tb-add');
                if (add) add.disabled = !pattern || patternsOf(input).some(p => p.toLowerCase() === pattern.toLowerCase());
            }
        });
        box.addEventListener('change', (e) => {
            own(e);
            const t = e.target;
            if (t.classList.contains('tb-platform')) {
                st.parts.platform = t.value || null;
                if (!kindOf(st.parts)) st.parts.event = '';
            } else if (t.classList.contains('tb-channel')) {
                if (t.value === '__type') st.typing = true;
                else st.parts.channel = t.value;
            } else if (t.classList.contains('tb-channel-text')) {
                st.parts.channel = t.value.trim();
            } else if (t.classList.contains('tb-event')) {
                st.parts.event = t.value;
            } else return;
            render();
        });
        // Typing in the text box redraws the chips
        input.addEventListener('input', () => { if (!box.contains(document.activeElement)) render(); });
        render();
    }

    // Every event card's pattern box (after the cards are drawn)
    function mountAll(root) {
        (root || document).querySelectorAll('.trigger-card').forEach(card => {
            const type = card.querySelector('.t-trigger-type');
            if (type && type.value !== 'event') return;
            const input = card.querySelector('input.t-trigger');
            if (input && input.type === 'text') mount(input);
        });
    }

    // {amount}: the event's amount — the last wildcard that's a number
    // ("Twitch * cheer * bits" catches the channel first), else the event's
    // own (bits, amount, level), else the first wildcard
    function numberIn(s) {
        const m = String(s ?? '').trim().match(/^([^\d\s]{0,3})([\d][\d.,]*)\s*(bits?|[^\w\s]{0,2})?$/i);
        return m ? m[2].replace(/,/g, '').replace(/\.$/, '') : null;
    }

    function eventAmount(matches, payload) {
        const list = Array.isArray(matches) ? matches.slice().reverse() : [];
        for (const w of list) { const n = numberIn(w); if (n !== null) return n; }
        const d = (payload && payload.customData) || {};
        for (const k of ['amount', 'bits', 'level']) { const n = numberIn(d[k]); if (n !== null) return n; }
        return Array.isArray(matches) && matches[0] !== undefined ? matches[0] : '';
    }

    const style = document.createElement('style');
    style.textContent = `
        .tb-box { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
        .tb-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        .tb-chip { background: #2a2d2e; border: 1px solid #3c3c3c; border-radius: 12px; padding: 2px 4px 2px 10px; cursor: pointer; font-size: 0.85em; display: inline-flex; gap: 6px; align-items: center; }
        .tb-chip:hover { border-color: var(--accent, #007acc); }
        .tb-chip-editing { border-color: var(--accent, #007acc); background: #094771; }
        .tb-chip-x { color: #aaa; padding: 0 6px; border-radius: 10px; }
        .tb-chip-x:hover { color: #fff; background: #c62828; }
        .tb-toggle { padding: 2px 10px !important; font-size: 0.8em !important; background: #3a3d41 !important; }
        .tb-lists { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; font-size: 0.85em; }
        .tb-lists label { display: inline-flex; gap: 6px; align-items: center; margin: 0; }
        .tb-lists select, .tb-lists input { width: auto !important; min-width: 90px; padding: 4px 6px !important; height: 30px; background: #1a1a1a; border: 1px solid #444; color: white; border-radius: 4px; }
        .tb-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 0.85em; }
        .tb-actions button { padding: 4px 10px !important; font-size: 0.9em !important; }
        .tb-actions button:disabled { opacity: 0.45; cursor: default; }
        .tb-actions code { background: #111; padding: 3px 8px; border-radius: 4px; color: #9cdcfe; }
        .tb-weak { color: #999; font-size: 0.85em; }
    `;
    document.head.appendChild(style);

    loadTheaterSeen();

    window.TriggerBuilder = { compose, parse, fromEvent, mount, mountAll, onReaderMessage, loadTheaterSeen, eventAmount, numberIn };
})();
