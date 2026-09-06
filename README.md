# Network Flow Card

A Lovelace card that draws your network as a flow diagram, in the spirit of
[power-flow-card-plus](https://github.com/flixlix/power-flow-card-plus). Devices
sit on levels, links are drawn as two lanes (download and upload), and dots
travel along each lane at a speed that tracks the actual throughput.

It reads plain Home Assistant sensors, so any integration that exposes a rate
works — it isn't tied to any one networking vendor.

No dependencies and no build step — it's a single vanilla web component.

## Install

### HACS (custom repository)

1. HACS → three-dot menu → **Custom repositories**
2. Add `https://github.com/<your-username>/home-assistant-network-flow-card`
   with category **Dashboard**
3. Install, then hard-refresh your browser

### Manual

1. Copy `dist/network-flow-card.js` to `/config/www/`
2. Settings → Dashboards → three-dot menu → **Resources** → Add resource
   - URL `/local/network-flow-card.js`
   - Type **JavaScript Module**
3. Hard-refresh your browser

## Example

The topology below is two ISP modems into a router, down through a switch to
a wired access point and a second switch, out to two mesh access points, and
finally a third switch hanging off one of them.

```yaml
type: custom:network-flow-card
title: Network
nodes:
  - id: wan1
    name: WAN 1
    type: modem
    level: 0
    max_speed: 300
    latency: sensor.wan1_latency
    download: sensor.wan1_rx_speed
    upload: sensor.wan1_tx_speed
  - id: wan2
    name: WAN 2
    type: modem
    level: 0
    max_speed: 150
    latency: sensor.wan2_latency
    download: sensor.wan2_rx_speed
    upload: sensor.wan2_tx_speed

  - id: gateway
    name: Gateway
    type: router
    level: 1
    state: sensor.gateway_state
    secondary: sensor.gateway_clients
    secondary_unit: clients

  - id: core_switch
    name: Core Switch
    type: switch
    level: 2

  - id: main_ap
    name: Main AP
    type: ap
    level: 3
  - id: office_switch
    name: Office Switch
    type: switch
    level: 3

  - id: kitchen_ap
    name: Kitchen AP
    type: ap
    level: 4
    secondary: sensor.kitchen_ap_clients
    secondary_unit: clients
  - id: bedroom_ap
    name: Bedroom AP
    type: ap
    level: 4
    secondary: sensor.bedroom_ap_clients
    secondary_unit: clients

  - id: bedroom_switch
    name: Bedroom Switch
    type: switch
    level: 5

links:
  - { from: wan1, to: gateway }
  - { from: wan2, to: gateway }
  - { from: gateway, to: core_switch }
  - { from: core_switch, to: main_ap }
  - { from: core_switch, to: office_switch }
  - { from: main_ap, to: kitchen_ap, wireless: true, label: mesh }
  - { from: main_ap, to: bedroom_ap, wireless: true, label: mesh }
  - { from: bedroom_ap, to: bedroom_switch }
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
| `node_radius` | `34` | Node circle radius in px. |
| `row_gap` | `56` | Vertical space between levels in px. |

### Nodes

| Option | Default | Description |
| --- | --- | --- |
| `id` | required | Unique key, referenced by links. |
| `level` | `0` | Row, counting from the top. Nodes are positioned under their parent(s) — siblings sharing one parent fan out symmetrically around it; nodes with no parent in an earlier level are spread evenly instead. |
| `name` | `id` | Label under the circle. |
| `type` | — | `modem`, `router`, `switch` or `ap`. Sets the default icon and colour. |
| `icon` | by type | Any `mdi:` icon. |
| `color` | by type | Any CSS colour. |
| `download` / `upload` | — | Rate sensors. Shown inside the circle and used to animate links that don't define their own. |
| `latency` | — | Sensor in ms, shown under the name. |
| `secondary` | — | Any entity. Shown inside the circle if the node has no rates, otherwise as an extra line below the name. |
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
--nfc-down-color: "#2196f3"
--nfc-up-color: "#ff9800"
```

Node colours come from `color:` per node. The card respects
`prefers-reduced-motion` and hides the dots when it's set.

## A note on LAN throughput sensors

Many integrations only publish client counts, latency, CPU and memory for
LAN-side devices — not per-device or per-port throughput. So links inside the
LAN draw as static lanes unless you supply rate sensors yourself.

If your integration exposes cumulative bandwidth counters instead of a rate,
wrap each one in a
[Derivative helper](https://www.home-assistant.io/integrations/derivative/) with
a unit time of seconds to turn it into a rate, then point the link's `download`
and `upload` at the derivative sensors.

WAN links usually work out of the box, because most modem and gateway
integrations expose an instantaneous rate.

## License

MIT
