/**
 * Network Flow Card
 * A Home Assistant Lovelace card that draws your network topology as a flow
 * diagram, in the spirit of power-flow-card-plus: nodes on levels, throughput
 * shown as dots travelling along the links.
 *
 * No build step, no dependencies. Drop this file in /config/www/ and add it as
 * a Lovelace resource of type "JavaScript Module".
 */

const CARD_VERSION = "2026.09.06.1516";

const DEFAULTS = {
  width: 520,
  node_radius: 34,
  row_gap: 56,
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

class NetworkFlowCard extends HTMLElement {
  static getStubConfig() {
    return {
      type: "custom:network-flow-card",
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
      throw new Error("network-flow-card: 'nodes' must be a non-empty list");
    }

    const opts = { ...DEFAULTS, ...config };

    const nodes = config.nodes.map((n, i) => {
      if (!n.id) throw new Error(`network-flow-card: node #${i + 1} has no 'id'`);
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
      if (!from) throw new Error(`network-flow-card: link #${i + 1} 'from: ${l.from}' is not a known node id`);
      if (!to) throw new Error(`network-flow-card: link #${i + 1} 'to: ${l.to}' is not a known node id`);

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
    // Rates and a rate-less secondary value live inside the circle (like
    // the HA energy card's icon+value). Only latency, and a secondary value
    // that lost the inside slot to rates, spill out below the name.
    const hasRates = !!(node.download || node.upload);
    let lines = 0;
    if (node.latency) lines += 1;
    if (node.secondary && hasRates) lines += 1;
    return lines;
  }

  _layout() {
    const cfg = this._config;
    const R = cfg.node_radius;
    const levels = [...new Set(cfg.nodes.map((n) => n.level))].sort((a, b) => a - b);
    const rows = levels.map((lv) => cfg.nodes.filter((n) => n.level === lv));
    const widest = Math.max(...rows.map((r) => r.length));
    const minGap = 136;
    const W = Math.max(cfg.width, widest * minGap);

    // A node whose only link to an earlier level is shared with a sibling
    // (e.g. two mesh APs off the same wired AP) should fan out symmetrically
    // under that parent, not sit wherever plain declaration-order spacing
    // happens to put it — otherwise one child can land dead straight below
    // the parent while the other bends, making a perfectly symmetric mesh
    // read as lopsided. So each row (after the first) is positioned from the
    // barycenter of each node's already-placed parents, with tied targets
    // (siblings sharing the same parent set) spread evenly around that
    // shared point instead of stacking to one side.
    const parentsOf = new Map(cfg.nodes.map((n) => [n.id, []]));
    cfg.links.forEach((l) => {
      if (l.from.level < l.to.level) parentsOf.get(l.to.id).push(l.from);
      else if (l.to.level < l.from.level) parentsOf.get(l.from.id).push(l.to);
    });

    let y = 14;
    rows.forEach((row) => {
      const statLines = Math.max(0, ...row.map((n) => this._statLines(n)));
      const cy = y + R + 2;

      const fallback = row.map((n, i) => (W * (i + 1)) / (row.length + 1));
      const want = row.map((n, i) => {
        const parents = parentsOf.get(n.id).filter((p) => p.x != null);
        return parents.length
          ? parents.reduce((s, p) => s + p.x, 0) / parents.length
          : fallback[i];
      });

      // Siblings that share the same target fan out evenly around it.
      const groups = new Map();
      want.forEach((w, i) => {
        const k = Math.round(w * 100) / 100;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(i);
      });
      const spread = new Array(row.length);
      groups.forEach((idxs, target) => {
        idxs.forEach((idx, pos) => {
          spread[idx] = target + minGap * (pos - (idxs.length - 1) / 2);
        });
      });

      // Resolve any remaining overlap between different targets left-to-right.
      const order = row.map((_, i) => i).sort((a, b) => spread[a] - spread[b] || a - b);
      const xs = new Array(row.length);
      let last = -Infinity;
      order.forEach((idx) => {
        const x = Math.max(spread[idx], last + minGap);
        xs[idx] = x;
        last = x;
      });

      // Keep the row's own span on-stage without re-centering it on the
      // full card width, which would undo the symmetry just computed.
      const pad = minGap / 2;
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      let shift = 0;
      if (lo < pad) shift = pad - lo;
      else if (hi > W - pad) shift = W - pad - hi;

      row.forEach((n, i) => {
        n.x = xs[i] + shift;
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

    // Vertical link between levels, drawn the way the HA energy card draws
    // its flows: straight out of the node, one smooth bend, straight into
    // the next node — instead of an S-curve that bends at both ends.
    const inset = Math.sqrt(Math.max(0, R * R - L * L));
    const y1 = a.y + inset;
    const y2 = b.y - inset;
    const span = Math.max(0, y2 - y1);
    const lead = Math.min(clamp(span * 0.3, 10, 34), span * 0.4);
    const bendH = Math.max(span - 2 * lead, span * 0.2);

    const elbow = (x1, x2) => {
      const yA = y1 + lead;
      const yB = yA + bendH;
      return (
        `M ${x1} ${y1} L ${x1} ${yA} ` +
        `C ${x1} ${yA + bendH * 0.55}, ${x2} ${yB - bendH * 0.55}, ${x2} ${yB} ` +
        `L ${x2} ${y2}`
      );
    };

    const dx1 = a.x - L;
    const dx2 = b.x - L;
    const ux1 = a.x + L;
    const ux2 = b.x + L;

    return {
      lateral: false,
      down: elbow(dx1, dx2),
      up: elbow(ux1, ux2),
      mid: { x: (a.x + b.x) / 2, y: y1 + lead + bendH / 2 },
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
    const safeKey = link.key.replace(/[^a-zA-Z0-9_-]/g, "_");
    // Flow dots use the same technique as the HA energy card: a tiny circle
    // riding an <mpath> reference to the lane's own path, sized with a
    // non-scaling stroke so it stays a crisp fixed-size dot however far the
    // card scales its stage to fit the column.
    const dots = (dir) => {
      const out = [];
      const pathId = `lane-${safeKey}-${dir}`;
      for (let i = 0; i < this._config.dots; i++) {
        const rev = dir === "up"
          ? ' keyPoints="1;0" keyTimes="0;1" calcMode="linear"'
          : "";
        out.push(
          `<circle class="dot ${dir}" r="1" vector-effect="non-scaling-stroke" data-dir="${dir}" data-i="${i}">` +
            `<animateMotion dur="4s" begin="0s" repeatCount="indefinite"${rev}>` +
              `<mpath xlink:href="#${pathId}"></mpath>` +
            `</animateMotion>` +
          `</circle>`
        );
      }
      return out.join("");
    };
    return (
      `<g class="link" data-key="${link.key}">` +
        `<path id="lane-${safeKey}-down" class="${cls} down" vector-effect="non-scaling-stroke" d="${g.down}"></path>` +
        `<path id="lane-${safeKey}-up" class="${cls} up" vector-effect="non-scaling-stroke" d="${g.up}"></path>` +
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
        (link.explicit
          ? `<span class="rate down" data-role="down">—</span>` +
            `<span class="rate up" data-role="up">—</span>`
          : "") +
      `</div>`
    );
  }

  _nodeMarkup(node) {
    const R = this._config.node_radius;
    const hasRates = !!(node.download || node.upload);

    // Like the HA energy card's circles (icon + value stacked inside a
    // bordered ring): rates take the inside slot when present, otherwise a
    // secondary value fills it. Whatever doesn't fit spills below the name.
    let inside = "";
    if (hasRates) {
      inside =
        (node.download
          ? `<div class="rate-line down"><ha-icon class="small" icon="mdi:arrow-down"></ha-icon><span data-role="download">—</span></div>`
          : "") +
        (node.upload
          ? `<div class="rate-line up"><ha-icon class="small" icon="mdi:arrow-up"></ha-icon><span data-role="upload">—</span></div>`
          : "");
    } else if (node.secondary) {
      inside = `<div class="rate-line"><span data-role="secondary-inside">—</span></div>`;
    }

    const stats = [];
    if (node.latency) {
      stats.push(`<div class="stat"><span data-role="latency">—</span></div>`);
    }
    if (node.secondary && hasRates) {
      stats.push(`<div class="stat muted"><span data-role="secondary">—</span></div>`);
    }

    return (
      `<div class="node" data-id="${node.id}" style="left:${node.x}px;top:${node.y}px;--node-color:${node.color}">` +
        `<div class="circle" tabindex="0" role="button" style="width:${2 * R}px;height:${2 * R}px">` +
          `<ha-icon icon="${node.icon}"></ha-icon>` +
          inside +
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
        secondaryInside: el.querySelector('[data-role="secondary-inside"]'),
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
      if (els.secondary || els.secondaryInside) {
        const st = hass.states[n.secondary.entity];
        const val = st ? st.state : null;
        const unit = n.secondary_unit || (st && st.attributes.unit_of_measurement) || "";
        const text = val == null ? "—" : `${val}${unit ? " " + unit : ""}`;
        if (els.secondary) els.secondary.textContent = text;
        if (els.secondaryInside) els.secondaryInside.textContent = text;
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
        d.style.strokeWidth = (3.2 + ratio * 2.4).toFixed(2);
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
    // Visual language borrowed straight from HA's own Energy Distribution
    // card: a bordered circle per node with its icon + value stacked inside,
    // a muted label underneath, and flow lines that run straight out of a
    // node, bend once, and run straight into the next — with a small solid
    // dot (non-scaling stroke, exactly like the energy card's flow dots)
    // riding each lane to show live throughput.
    return `
      :host { display: block; --mdc-icon-size: 24px; }
      ha-card { overflow: hidden; }
      .content { padding: 4px 8px 12px; position: relative; }
      .viewport { position: relative; width: 100%; overflow: hidden; }
      .stage { position: absolute; top: 0; left: 0; transform-origin: top left; }
      svg.links { position: absolute; top: 0; left: 0; overflow: visible; }

      .lane {
        fill: none;
        stroke-width: 1.6;
        stroke-linecap: round;
        opacity: 0.55;
      }
      .lane.down { stroke: var(--nfc-down-color, #2196f3); }
      .lane.up { stroke: var(--nfc-up-color, #ff9800); }
      .lane.wireless { stroke-dasharray: 5 5; opacity: 0.45; }
      .lane.idle { opacity: 0.16; }

      .dot { stroke-width: 3.2px; }
      .dot.down { fill: var(--nfc-down-color, #2196f3); stroke: var(--nfc-down-color, #2196f3); }
      .dot.up { fill: var(--nfc-up-color, #ff9800); stroke: var(--nfc-up-color, #ff9800); }

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
        border-radius: var(--ha-border-radius-circle, 50%);
        border: 2px solid var(--node-color);
        background: var(--card-background-color, var(--ha-card-background, #fff));
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        font-size: var(--ha-font-size-s, 12px);
        line-height: 1.15;
        color: var(--primary-text-color);
        position: relative;
      }
      .circle.tappable { cursor: pointer; }
      .circle.tappable:hover { background: color-mix(in srgb, var(--node-color) 12%, var(--card-background-color, #fff)); }
      .circle:focus-visible { outline: 2px solid var(--node-color); outline-offset: 3px; }
      .circle > ha-icon:first-child { --mdc-icon-size: 22px; width: 22px; height: 22px; color: var(--node-color); padding-bottom: 1px; }

      .rate-line {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 1px;
        font-size: 9px;
        line-height: 11px;
        white-space: nowrap;
      }
      .rate-line ha-icon.small { --mdc-icon-size: 10px; width: 10px; height: 10px; }
      .rate-line.down { color: var(--nfc-down-color, #2196f3); }
      .rate-line.up { color: var(--nfc-up-color, #ff9800); }

      .name {
        margin-top: 6px;
        font-size: var(--ha-font-size-s, 12px);
        line-height: 14px;
        color: var(--secondary-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .stats { margin-top: 1px; }
      .stat {
        font-size: 11px;
        line-height: 15px;
        color: var(--secondary-text-color);
        white-space: nowrap;
      }
      .stat.muted { opacity: 0.75; }

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
      .link-label .rate::before { margin-right: 2px; font-size: 10px; }
      .link-label .rate.down { color: var(--nfc-down-color, #2196f3); }
      .link-label .rate.down::before { content: "\\2193"; }
      .link-label .rate.up { color: var(--nfc-up-color, #ff9800); }
      .link-label .rate.up::before { content: "\\2191"; }

      @media (prefers-reduced-motion: reduce) {
        .dot { display: none; }
        .lane { opacity: 0.7; }
      }
    `;
  }
}

if (!customElements.get("network-flow-card")) {
  customElements.define("network-flow-card", NetworkFlowCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "network-flow-card",
  name: "Network Flow Card",
  description: "Network topology with live throughput animation, styled after the power flow card.",
  preview: false,
});

console.info(
  `%c NETWORK-FLOW-CARD %c v${CARD_VERSION} `,
  "color:#fff;background:#0559c9;font-weight:700",
  "color:#0559c9;background:#eee"
);
