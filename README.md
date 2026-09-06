# Network Flow Card

A Lovelace card that draws your network as a flow diagram, in the spirit of
[power-flow-card-plus](https://github.com/flixlix/power-flow-card-plus). Devices
sit on levels, links are drawn as two lanes (download and upload), and dots
travel along each lane at a speed that tracks the actual throughput.

Built for UniFi, but it reads plain Home Assistant sensors, so any integration
that exposes a rate will work.

No dependencies and no build step — it's a single vanilla web component.

## Install

### HACS (custom repository)

1. HACS → three-dot menu → **Custom repositories**
2. Add `https://github.com/<your-username>/home-assistant-network-flow-card`
   with category **Dashboard**
3. Install, then hard-refresh your browser

### Manual

1. Copy `dist/unifi-network-flow-card.js` to `/config/www/`
2. Settings → Dashboards → three-dot menu → **Resources** → Add resource
   - URL `/local/unifi-network-flow-card.js`
   - Type **JavaScript Module**
3. Hard-refresh your browser

## Example

The topology below is two LTE modems into a UniFi gateway, down through a PoE
switch to a wired AP and a second switch, out to two mesh APs, and finally a
third switch hanging off one of them.

```yaml
type: custom:unifi-network-flow-card
title: Network
nodes:
  - id: mr600
    name: MR600
    type: modem
    level: 0
    max_speed: 300
    latency: sensor.ucg_ultra_cloudflare_wan_latency
    download: sensor.tp_link_mr600_lte_current_rx_speed
    upload: sensor.tp_link_mr600_lte_current_tx_speed
  - id: mr200
    name: MR200
    type: modem
    level: 0
    max_speed: 150
    latency: sensor.ucg_ultra_cloudflare_wan2_latency
    download: sensor.tp_link_mr200_lte_current_rx_speed
    upload: sensor.tp_link_mr200_lte_current_tx_speed

  - id: ucg
    name: UCG Ultra
    type: router
    level: 1
    state: sensor.ucg_ultra_state
    secondary: sensor.ucg_ultra_clients
    secondary_unit: clients

  - id: usw8
    name: USW Lite 8 PoE
    type: switch
    level: 2

  - id: acpro
    name: UAP AC Pro
    type: ap
    level: 3
  - id: flex1
    name: Flex Mini 1
    type: switch
    level: 3

  - id: kitchen
    name: AC Lite Kitchen
    type: ap
    level: 4
    secondary: sensor.uap_ac_lite_kitchen_clients
    secondary_unit: clients
  - id: bedroom
    name: AC Lite Bedroom
    type: ap
    level: 4
    secondary: sensor.uap_ac_lite_bedroom_clients
    secondary_unit: clients

  - id: flex2
    name: Flex Mini 2
    type: switch
    level: 5

links:
  - { from: mr600, to: ucg }
  - { from: mr200, to: ucg }
  - { from: ucg, to: usw8 }
  - { from: usw8, to: acpro }
  - { from: usw8, to: flex1 }
  - { from: acpro, to: kitchen, wireless: true, label: mesh }
  - { from: acpro, to: bedroom, wireless: true, label: mesh }
  - { from: bedroom, to: flex2 }
```

## Configuration

### Card

| Option | Default | Description |
| --- | --- | --- |
| `title` | — | Card header. Omit for no header. |
| `nodes` | required | List of devices. |
| `links` | `[]` | List of connections between nodes. |
| `max_speed` | `1000` | Throughput in Mbit/s treated as full speed when scaling the animation. Node and link values override this. |
| `min_speed` | `0.02` | Below this (Mbit/s) a link counts as idle: the lane dims and the dots stop. |
| `dots` | `3` | Dots per lane. |
| `max_duration` | `6.0` | Seconds for a dot to cross a barely-active link. |
| `min_duration` | `0.8` | Seconds for a dot to cross a saturated link. |
| `width` | `520` | Internal design width in px. The card scales to fit its column. |
| `node_radius` | `28` | Node circle radius in px. |
| `row_gap` | `52` | Vertical space between levels in px. |

### Nodes

| Option | Default | Description |
| --- | --- | --- |
| `id` | required | Unique key, referenced by links. |
| `level` | `0` | Row, counting from the top. Nodes sharing a level are spread evenly across it. |
| `name` | `id` | Label under the circle. |
| `type` | — | `modem`, `router`, `switch` or `ap`. Sets the default icon and colour. |
| `icon` | by type | Any `mdi:` icon. |
| `color` | by type | Any CSS colour. |
| `download` / `upload` | — | Rate sensors. Shown under the name and used to animate links that don't define their own. |
| `latency` | — | Sensor in ms, shown under the name. |
| `secondary` | — | Any entity, shown as a third line. |
| `secondary_unit` | entity's unit | Overrides the unit on that line. |
| `state` | — | Entity that says whether the device is up. `off`, `unavailable`, `unknown`, `disconnected`, `offline`, `down` or `not_home` fades the node and stops its links. |
| `entity` | first sensor | Entity opened when the circle is tapped. |
| `max_speed` | card value | Full-speed reference for this node. |

### Links

| Option | Default | Description |
| --- | --- | --- |
| `from` / `to` | required | Node ids. Linking two nodes on the same level draws a horizontal pair of lanes instead of a vertical one. |
| `download` / `upload` | inherited | Rate sensors for this link. When omitted the card falls back to the `to` node's sensors, then the `from` node's. |
| `wireless` | `false` | Draws the lanes dashed. |
| `label` | — | Small caption next to the link. |
| `max_speed` | node values | Full-speed reference for this link. |

Links that define their own `download`/`upload` also print live rates beside the
lanes. Links that inherit theirs don't, to avoid repeating the numbers already
shown under the node.

### Units

Values are normalised to Mbit/s from the entity's `unit_of_measurement`:
`B/s`, `kB/s`, `MB/s`, `GB/s`, `bit/s`, `kbit/s`, `Mbit/s`, `Gbit/s` and the
common aliases. A sensor with no unit is assumed to be Mbit/s. Override per
sensor with the long form:

```yaml
download:
  entity: sensor.wan_rx
  unit: B/s
  multiplier: 1
```

`attribute:` is also supported, for sensors that keep the rate in an attribute.

### Theming

Set these anywhere in your theme or via `card_mod`:

```yaml
--unf-down-color: "#2196f3"
--unf-up-color: "#ff9800"
```

Node colours come from `color:` per node. The card respects
`prefers-reduced-motion` and hides the dots when it's set.

## A note on UniFi throughput sensors

The UniFi integration doesn't publish per-device or per-port throughput — only
client counts, latency, CPU and memory. So links inside the LAN draw as static
lanes unless you supply rate sensors yourself.

To animate them, enable the per-client bandwidth entities (they're disabled by
default and report cumulative MB), then wrap each in a
[Derivative helper](https://www.home-assistant.io/integrations/derivative/) with
a unit time of seconds to turn it into a rate. Point the link's `download` and
`upload` at the derivative sensors.

WAN links usually work out of the box, because most modem and gateway
integrations expose an instantaneous rate.

## Development

`examples/preview.html` is a standalone page that runs the card against a fake
`hass` object with simulated traffic. Open it in a browser — no Home Assistant
needed. It stubs `ha-card` and `ha-icon`, so the icons are rough stand-ins.

## License

MIT
