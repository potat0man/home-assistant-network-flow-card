/**
 * UniFi Network Flow Card
 * A Home Assistant Lovelace card that draws your network topology as a flow
 * diagram, in the spirit of power-flow-card-plus: nodes on levels, throughput
 * shown as dots travelling along the links.
 *
 * No build step, no dependencies. Drop this file in /config/www/ and add it as
 * a Lovelace resource of type "JavaScript Module".
 */

const CARD_VERSION = "1.0.0";

const DEFAULTS = {
  width: 520,
  node_radius: 28,
  row_gap: 52,
  dots: 3,
  max_speed: 1000, // Mbit/s that counts as "full speed" for animation scaling
  min_speed: 0.02, // Mbit/s below which a link is considered idle
  max_duration: 6.0, // seconds for a dot to cross an idle-ish link
  min_duration: 0.8, // seconds for a dot to cross a saturated link
  lane_offset: 7,
};

const COLORS = {
  modem: "#03a9f4",
  router: "#7e57c2",
  switch: "#26a69a",
  ap: "#ef6c00",
  default: "#78909c",
};

const TYPE_ICON = {
  modem: "mdi:web",
  router: "mdi:router-network",
  switch: "mdi:lan",
  ap: "mdi:access-point",
};

// Everything is normalised to Mbit/s internally.
const UNIT_TO_MBPS = {
  "bit/s": 1e-6, "b/s": 1e-6, "bps": 1e-6,
  "kbit/s": 1e-3, "kbps": 1e-3,
  "Mbit/s": 1, "Mb/s": 1, "Mbps": 1,
  "Gbit/s": 1e3, "Gb/s": 1e3, "Gbps": 1e3,
  "B/s": 8e-6, "Bps": 8e-6,
  "kB/s": 8e-3, "KB/s": 8e-3, "KiB/s": 8.192e-3,
  "MB/s": 8, "MiB/s": 8.389,
  "GB/s": 8e3, "GiB/s": 8589,
};

const OFFLINE_STATES = new Set([
  "off", "unavailable", "unknown", "disconnected", "offline", "down", "not_home",
]);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function mkSensor(def) {
  if (!def) return null;
  if (typeof def === "string") return { entity: def };
  if (typeof def === "object" && def.entity) return { ...def };
  return null;
}

function readSensor(hass, sensor) {
  if (!sensor || !hass) return { value: null, unit: null };
  const st = hass.states[sensor.entity];
  if (!st) return { value: null, unit: null };
  const raw = sensor.attribute ? st.attributes[sensor.attribute] : st.state;
  const v = parseFloat(raw);
  if (!isFinite(v)) return { value: null, unit: null };
  const mult = sensor.multiplier == null ? 1 : Number(sensor.multiplier);
  const unit = sensor.unit || st.attributes.unit_of_measurement || null;
  return { value: v * mult, unit };
}

function toMbps(reading) {
  if (reading.value == null) return null;
  const u = reading.unit;
  if (!u) return reading.value;
  if (UNIT_TO_MBPS[u] != null) return reading.value * UNIT_TO_MBPS[u];
  const key = Object.keys(UNIT_TO_MBPS).find(
    (k) => k.toLowerCase() === String(u).toLowerCase()
  );
  return key ? reading.value * UNIT_TO_MBPS[key] : reading.value;
}

function fmtRate(mbps) {
  if (mbps == null) return "—";
  if (mbps < 0.001) return "0 Mbps";
  if (mbps < 1) return `${(mbps * 1000).toFixed(0)} kbps`;
  if (mbps < 100) return `${mbps.toFixed(1)} Mbps`;
  if (mbps < 1000) return `${mbps.toFixed(0)} Mbps`;
  return `${(mbps / 1000).toFixed(2)} Gbps`;
}

function cubic(x1, y1, c1x, c1y, c2x, c2y, x2, y2) {
  return `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
}

function cubicMid(x1, y1, c1x, c1y, c2x, c2y, x2, y2) {
  return {
    x: (x1 + 3 * c1x + 3 * c2x + x2) / 8,
    y: (y1 + 3 * c1y + 3 * c2y + y2) / 8,
  };
}

class UnifiNetworkFlowCard extends HTMLElement {
  static getStubConfig() {
    return {
      type: "custom:unifi-network-flow-card",
      title: "Network",
      nodes: [
        { id: "wan", name: "WAN", type: "modem", level: 0 },
        { id: "router", name: "Router", type: "router", level: 1 },
      ],
      links: [{ from: "wan", to: "router" }],
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._nodeEls = new Map();
    this._linkEls = new Map();
    this._lastRatio = new Map();
    this._built = false;
  }

  // ---------------------------------------------------------------- config

  setConfig(config) {
    if (!config || !Array.isArray(config.nodes) || !config.nodes.length) {
      throw new Error("unifi-network-flow-card: 'nodes' must be a non-empty list");
    }

    const opts = { ...DEFAULTS, ...config };

    const nodes = config.nodes.map((n, i) => {
      if (!n.id) throw new Error(`unifi-network-flow-card: node #${i + 1} has no 'id'`);
      const type = n.type || "default";
      return {
        id: n.id,
        name: n.name || n.id,
        type,
        level: Number(n.level == null ? 0 : n.level),
        icon: n.icon || TYPE_ICON[type] || "mdi:lan-connect",
        color: n.color || COLORS[type] || COLORS.default,
        download: mkSensor(n.download),
        upload: mkSensor(n.upload),
        latency: mkSensor(n.latency),
        secondary: mkSensor(n.secondary),
        secondary_unit: n.secondary_unit || "",
        state_entity: n.state || null,
        entity: n.entity || null,
        max_speed: Number(n.max_speed == null ? opts.max_speed : n.max_speed),
      };
    });

    const byId = new Map(nodes.map((n) => [n.id, n]));

    const links = (config.links || []).map((l, i) => {
      const from = byId.get(l.from);
      const to = byId.get(l.to);
      if (!from) throw new Error(`unifi-network-flow-card: link #${i + 1} 'from: ${l.from}' is not a known node id`);
      if (!to) throw new Error(`unifi-network-flow-card: link #${i + 1} 'to: ${l.to}' is not a known node id`);

      let download = mkSensor(l.download);
      let upload = mkSensor(l.upload);
      const explicit = !!(download || upload);
      // Fall back to whichever endpoint publishes throughput: the far end
      // first (a WAN modem's own sensors describe its uplink), then the near.
      if (!explicit) {
        download = to.download || from.download;
        upload = to.upload || from.upload;
      }

      return {
        key: `${l.from}>${l.to}#${i}`,
        from,
        to,
        download,
        upload,
        explicit,
        label: l.label || null,
        wireless: !!l.wireless,
        max_speed: Number(l.max_speed == null ? Math.max(from.max_speed, to.max_speed) : l.max_speed),
      };
    });

    this._config = { ...opts, nodes, links, byId };
    this._built = false;
    this._nodeEls.clear();
    this._linkEls.clear();
    this._lastRatio.clear();
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._built) this._updateValues();
  }

  getCardSize() {
    if (!this._config) return 6;
    const levels = new Set(this._config.nodes.map((n) => n.level));
    return levels.size + 2;
  }

  connectedCallback() {
    if (this._config && !this._built) this._render();
    this._observe();
  }

  disconnectedCallback() {
    if (this._ro) this._ro.disconnect();
    this._ro = null;
  }

  // ---------------------------------------------------------------- layout

  _statLines(node) {
    let lines = 0;
    if (node.latency) lines += 1;
    if (node.download || node.upload) lines += 1;
    if (node.secondary) lines += 1;
    return lines;
  }

  _layout() {
    const cfg = this._config;
    const R = cfg.node_radius;
    const levels = [...new Set(cfg.nodes.map((n) => n.level))].sort((a, b) => a - b);
    const rows = levels.map((lv) => cfg.nodes.filter((n) => n.level === lv));
    const widest = Math.max(...rows.map((r) => r.length));
    const W = Math.max(cfg.width, widest * 136);

    let y = 14;
    rows.forEach((row) => {
      const statLines = Math.max(0, ...row.map((n) => this._statLines(n)));
      const cy = y + R + 2;
      row.forEach((n, i) => {
        n.x = (W * (i + 1)) / (row.length + 1);
        n.y = cy;
      });
      y += 2 * R + 8 + 18 + statLines * 16 + cfg.row_gap;
    });

    this._size = { W, H: y - cfg.row_gap + 14 };
  }

  _linkGeometry(link) {
    const cfg = this._config;
    const R = cfg.node_radius;
    const L = cfg.lane_offset;
    const a = link.from;
    const b = link.to;

    // Same level: a lateral link (mesh / stacked pair). Two straight lanes.
    if (a.level === b.level) {
      const dir = b.x > a.x ? 1 : -1;
      const inset = Math.sqrt(Math.max(0, R * R - L * L));
      const x1 = a.x + dir * inset;
      const x2 = b.x - dir * inset;
      return {
        lateral: true,
        down: cubic(x1, a.y - L, x1, a.y - L, x2, b.y - L, x2, b.y - L),
        up: cubic(x1, a.y + L, x1, a.y + L, x2, b.y + L, x2, b.y + L),
        mid: { x: (x1 + x2) / 2, y: a.y - L - 12 },
      };
    }

    // Vertical link between levels.
    const inset = Math.sqrt(Math.max(0, R * R - L * L));
    const y1 = a.y + inset;
    const y2 = b.y - inset;
    const bend = Math.max(26, (y2 - y1) * 0.45);

    const dx1 = a.x - L;
    const dx2 = b.x - L;
    const ux1 = a.x + L;
    const ux2 = b.x + L;

    const mid = cubicMid(dx1, y1, dx1, y1 + bend, dx2, y2 - bend, dx2, y2);

    return {
      lateral: false,
      down: cubic(dx1, y1, dx1, y1 + bend, dx2, y2 - bend, dx2, y2),
      up: cubic(ux1, y1, ux1, y1 + bend, ux2, y2 - bend, ux2, y2),
      mid: { x: mid.x, y: mid.y },
    };
  }

  // ---------------------------------------------------------------- render

  _render() {
    const cfg = this._config;
    if (!cfg) return;
    this._layout();
    const { W, H } = this._size;

    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <ha-card>
        ${cfg.title ? `<h1 class="card-header">${cfg.title}</h1>` : ""}
        <div class="content">
          <div class="viewport">
            <div class="stage" style="width:${W}px;height:${H}px">
              <svg class="links" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"></svg>
            </div>
          </div>
        </div>
      </ha-card>
    `;

    const stage = this.shadowRoot.querySelector(".stage");
    const svg = this.shadowRoot.querySelector("svg.links");

    svg.innerHTML = cfg.links.map((l) => this._linkMarkup(l)).join("");
    stage.insertAdjacentHTML("beforeend", cfg.links.map((l) => this._linkLabelMarkup(l)).join(""));
    stage.insertAdjacentHTML("beforeend", cfg.nodes.map((n) => this._nodeMarkup(n)).join(""));

    this._cacheElements();
    this._wireTaps();
    this._built = true;
    this._observe();
    this._fit();
    if (this._hass) this._updateValues();
  }

  _linkMarkup(link) {
    const g = this._linkGeometry(link);
    link._geom = g;
    const cls = `lane${link.wireless ? " wireless" : ""}`;
    const dots = (dir) => {
      const out = [];
      for (let i = 0; i < this._config.dots; i++) {
        const rev = dir === "up"
          ? ' keyPoints="1;0" keyTimes="0;1" calcMode="linear"'
          : "";
        out.push(
          `<circle class="dot ${dir}" r="3.2" data-dir="${dir}" data-i="${i}">` +
            `<animateMotion dur="4s" begin="0s" repeatCount="indefinite"${rev} path="${g[dir]}"></animateMotion>` +
          `</circle>`
        );
      }
      return out.join("");
    };
    return (
      `<g class="link" data-key="${link.key}">` +
        `<path class="${cls} down" d="${g.down}"></path>` +
        `<path class="${cls} up" d="${g.up}"></path>` +
        dots("down") +
        dots("up") +
      `</g>`
    );
  }

  _linkLabelMarkup(link) {
    if (!link.explicit && !link.label) return "";
    const g = link._geom;
    return (
      `<div class="link-label" data-key="${link.key}" style="left:${g.mid.x}px;top:${g.mid.y}px">` +
        (link.label ? `<span class="link-name">${link.label}</span>` : "") +
        `<span class="rate down" data-role="down">—</span>` +
        `<span class="rate up" data-role="up">—</span>` +
      `</div>`
    );
  }

  _nodeMarkup(node) {
    const R = this._config.node_radius;
    const stats = [];
    if (node.latency) {
      stats.push(`<div class="stat"><span data-role="latency">—</span></div>`);
    }
    if (node.download || node.upload) {
      stats.push(
        `<div class="stat rates">` +
          (node.download ? `<span class="rate down" data-role="download">—</span>` : "") +
          (node.upload ? `<span class="rate up" data-role="upload">—</span>` : "") +
        `</div>`
      );
    }
    if (node.secondary) {
      stats.push(`<div class="stat muted"><span data-role="secondary">—</span></div>`);
    }

    return (
      `<div class="node" data-id="${node.id}" style="left:${node.x}px;top:${node.y}px;--node-color:${node.color}">` +
        `<div class="circle" tabindex="0" role="button" style="width:${2 * R}px;height:${2 * R}px">` +
          `<ha-icon icon="${node.icon}"></ha-icon>` +
        `</div>` +
        `<div class="name">${node.name}</div>` +
        `<div class="stats">${stats.join("")}</div>` +
      `</div>`
    );
  }

  _cacheElements() {
    const root = this.shadowRoot;
    this._nodeEls.clear();
    this._config.nodes.forEach((n) => {
      const el = root.querySelector(`.node[data-id="${n.id}"]`);
      this._nodeEls.set(n.id, {
        root: el,
        latency: el.querySelector('[data-role="latency"]'),
        download: el.querySelector('[data-role="download"]'),
        upload: el.querySelector('[data-role="upload"]'),
        secondary: el.querySelector('[data-role="secondary"]'),
      });
    });

    this._linkEls.clear();
    this._config.links.forEach((l) => {
      const g = root.querySelector(`g.link[data-key="${l.key}"]`);
      const label = root.querySelector(`.link-label[data-key="${l.key}"]`);
      this._linkEls.set(l.key, {
        group: g,
        down: {
          path: g.querySelector("path.down"),
          dots: [...g.querySelectorAll('circle.dot[data-dir="down"]')],
          label: label ? label.querySelector('[data-role="down"]') : null,
        },
        up: {
          path: g.querySelector("path.up"),
          dots: [...g.querySelectorAll('circle.dot[data-dir="up"]')],
          label: label ? label.querySelector('[data-role="up"]') : null,
        },
      });
    });
  }

  _wireTaps() {
    this._config.nodes.forEach((n) => {
      const el = this._nodeEls.get(n.id).root.querySelector(".circle");
      const entityId =
        n.entity ||
        n.state_entity ||
        (n.download && n.download.entity) ||
        (n.latency && n.latency.entity) ||
        (n.secondary && n.secondary.entity);
      if (!entityId) return;
      el.classList.add("tappable");
      const fire = () => {
        this.dispatchEvent(
          new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId },
          })
        );
      };
      el.addEventListener("click", fire);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fire();
        }
      });
    });
  }

  // ---------------------------------------------------------------- values

  _updateValues() {
    const cfg = this._config;
    const hass = this._hass;
    if (!hass) return;

    cfg.nodes.forEach((n) => {
      const els = this._nodeEls.get(n.id);
      if (!els) return;

      if (els.latency) {
        const r = readSensor(hass, n.latency);
        els.latency.textContent = r.value == null ? "—" : `${Math.round(r.value)} ms`;
      }
      if (els.download) {
        els.download.textContent = fmtRate(toMbps(readSensor(hass, n.download)));
      }
      if (els.upload) {
        els.upload.textContent = fmtRate(toMbps(readSensor(hass, n.upload)));
      }
      if (els.secondary) {
        const st = hass.states[n.secondary.entity];
        const val = st ? st.state : null;
        const unit = n.secondary_unit || (st && st.attributes.unit_of_measurement) || "";
        els.secondary.textContent = val == null ? "—" : `${val}${unit ? " " + unit : ""}`;
      }

      let offline = false;
      if (n.state_entity) {
        const st = hass.states[n.state_entity];
        offline = !st || OFFLINE_STATES.has(String(st.state).toLowerCase());
      }
      els.root.classList.toggle("offline", offline);
      n._offline = offline;
    });

    cfg.links.forEach((l) => this._updateLink(l));
  }

  _updateLink(link) {
    const els = this._linkEls.get(link.key);
    if (!els) return;
    const dead = link.from._offline || link.to._offline;

    ["down", "up"].forEach((dir) => {
      const sensor = dir === "down" ? link.download : link.upload;
      const mbps = dead ? 0 : toMbps(readSensor(this._hass, sensor));
      const lane = els[dir];

      if (lane.label) lane.label.textContent = fmtRate(mbps);

      const active = mbps != null && mbps >= this._config.min_speed;
      lane.path.classList.toggle("idle", !active);

      if (!active) {
        lane.dots.forEach((d) => d.setAttribute("opacity", "0"));
        this._lastRatio.set(link.key + dir, -1);
        return;
      }

      const max = Math.max(link.max_speed, 1);
      const ratio = clamp(Math.log10(1 + mbps) / Math.log10(1 + max), 0, 1);
      const dur =
        this._config.max_duration -
        (this._config.max_duration - this._config.min_duration) * ratio;

      lane.dots.forEach((d) => {
        d.setAttribute("opacity", "1");
        d.setAttribute("r", (2.6 + ratio * 2.4).toFixed(2));
      });

      // Only touch the animation when the rate has moved meaningfully,
      // so steady traffic doesn't make the dots stutter on every poll.
      const prev = this._lastRatio.get(link.key + dir);
      if (prev == null || Math.abs(ratio - prev) > 0.06) {
        this._lastRatio.set(link.key + dir, ratio);
        lane.dots.forEach((d, i) => {
          const anim = d.querySelector("animateMotion");
          if (!anim) return;
          anim.setAttribute("dur", `${dur.toFixed(2)}s`);
          anim.setAttribute("begin", `${(-(i * dur) / lane.dots.length).toFixed(2)}s`);
        });
      }
    });
  }

  // ---------------------------------------------------------------- sizing

  _observe() {
    if (this._ro || !this.shadowRoot) return;
    const vp = this.shadowRoot.querySelector(".viewport");
    if (!vp || typeof ResizeObserver === "undefined") return;
    this._ro = new ResizeObserver(() => this._fit());
    this._ro.observe(vp);
  }

  _fit() {
    const vp = this.shadowRoot.querySelector(".viewport");
    const stage = this.shadowRoot.querySelector(".stage");
    if (!vp || !stage || !this._size) return;
    const avail = vp.clientWidth;
    if (!avail) return;
    const scale = clamp(avail / this._size.W, 0.4, 1.5);
    stage.style.transform = `scale(${scale})`;
    vp.style.height = `${this._size.H * scale}px`;
  }

  // ---------------------------------------------------------------- styles

  _styles() {
    return `
      :host { display: block; }
      ha-card { overflow: hidden; }
      .content { padding: 4px 8px 12px; }
      .viewport { position: relative; width: 100%; overflow: hidden; }
      .stage { position: absolute; top: 0; left: 0; transform-origin: top left; }
      svg.links { position: absolute; top: 0; left: 0; overflow: visible; }

      .lane {
        fill: none;
        stroke-width: 1.6;
        stroke-linecap: round;
        opacity: 0.55;
      }
      .lane.down { stroke: var(--unf-down-color, #2196f3); }
      .lane.up { stroke: var(--unf-up-color, #ff9800); }
      .lane.wireless { stroke-dasharray: 5 5; opacity: 0.45; }
      .lane.idle { opacity: 0.18; }

      .dot.down { fill: var(--unf-down-color, #2196f3); }
      .dot.up { fill: var(--unf-up-color, #ff9800); }

      .node {
        position: absolute;
        width: 128px;
        margin-left: -64px;
        margin-top: -30px;
        text-align: center;
        transition: opacity 180ms ease;
      }
      .node.offline { opacity: 0.35; }

      .circle {
        margin: 0 auto;
        border-radius: 50%;
        border: 2px solid var(--node-color);
        background: var(--card-background-color, #fff);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--node-color);
        box-sizing: border-box;
      }
      .circle.tappable { cursor: pointer; }
      .circle.tappable:hover { background: color-mix(in srgb, var(--node-color) 12%, var(--card-background-color, #fff)); }
      .circle:focus-visible { outline: 2px solid var(--node-color); outline-offset: 3px; }
      .circle ha-icon { --mdc-icon-size: 24px; width: 24px; height: 24px; }

      .name {
        margin-top: 5px;
        font-size: 12px;
        line-height: 14px;
        font-weight: 500;
        color: var(--primary-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .stats { margin-top: 1px; }
      .stat {
        font-size: 11px;
        line-height: 16px;
        color: var(--secondary-text-color);
        white-space: nowrap;
      }
      .stat.muted { opacity: 0.75; }
      .stat.rates { display: flex; gap: 8px; justify-content: center; }

      .rate::before { margin-right: 2px; font-size: 10px; }
      .rate.down { color: var(--unf-down-color, #2196f3); }
      .rate.down::before { content: "\\2193"; }
      .rate.up { color: var(--unf-up-color, #ff9800); }
      .rate.up::before { content: "\\2191"; }

      .link-label {
        position: absolute;
        transform: translate(6px, -50%);
        display: flex;
        flex-direction: column;
        font-size: 10px;
        line-height: 13px;
        white-space: nowrap;
        pointer-events: none;
      }
      .link-label .link-name { color: var(--secondary-text-color); }

      @media (prefers-reduced-motion: reduce) {
        .dot { display: none; }
        .lane { opacity: 0.7; }
      }
    `;
  }
}

if (!customElements.get("unifi-network-flow-card")) {
  customElements.define("unifi-network-flow-card", UnifiNetworkFlowCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "unifi-network-flow-card",
  name: "UniFi Network Flow Card",
  description: "Network topology with live throughput animation, styled after the power flow card.",
  preview: false,
});

console.info(
  `%c UNIFI-NETWORK-FLOW-CARD %c v${CARD_VERSION} `,
  "color:#fff;background:#0559c9;font-weight:700",
  "color:#0559c9;background:#eee"
);
