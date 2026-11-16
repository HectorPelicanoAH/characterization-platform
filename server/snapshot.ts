import { identify, type Screen } from "./screens.ts";
import { pageUrlFromResult } from "./domain.mjs";
import type { Evidence } from "../shared/model.ts";

export type ObservedComponent = { key: string; label: string; role: string; parentKey?: string };
export type ObservedControl = { key: string; label: string; role: string; componentKey?: string; ref?: string; disabled?: boolean };
export type InterfaceObservation = {
  evidenceId: number;
  screen: Screen;
  components: ObservedComponent[];
  controls: ObservedControl[];
  truncated: boolean;
};
export const semanticName = (text: string) => text.normalize("NFKC").toLowerCase()
  .replace(/\b\d+(?:[.,]\d+)?\b/g, "{n}").replace(/\s+/g, " ").trim();

const componentNames: Record<string, string> = {
  banner: "Header", contentinfo: "Footer", navigation: "Navigation", dialog: "Dialog",
  form: "Form", search: "Search", complementary: "Sidebar", tablist: "Tabs",
  radiogroup: "Options", toolbar: "Toolbar", menu: "Menu", region: "Section",
  group: "Group", list: "List", grid: "Grid", table: "Table", article: "Article", tabpanel: "Tab panel",
};
const controls = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox",
  "radio", "tab", "slider", "spinbutton", "switch", "menuitem", "option"]);
function componentLabel(role: string, label: string) {
  if (/^(?:imágenes|images|gallery|galer[ií]a)\b/i.test(label)) return "Image gallery";
  if (/^(?:selecciona(?:r)? (?:un |el )?color|select (?:a |the )?colo[u]?r)\b/i.test(label)) return "Color selector";
  if (/^(?:selecciona(?:r)? (?:tu |una |la )?talla|select (?:your |a |the )?size)\b/i.test(label) || /pdp\.addSize\.selector/i.test(label)) return "Size selector";
  if (/^(?:colores|colors|colours)$/i.test(label)) return "Color selector";
  if (/^(?:tallas|sizes)$/i.test(label)) return "Size selector";
  if (/^\d+\s*\/\s*\d+$/.test(label)) return "Paged " + (componentNames[role] ?? role).toLowerCase();
  return label || componentNames[role];
}

export function interfaceObservation(event: Evidence, previousScreen?: Screen): InterfaceObservation | undefined {
  if (!event.ok) return;
  const url = pageUrlFromResult(event.detail);
  const title = event.detail.match(/^- Page Title:\s*(.+)/m)?.[1];
  const screen = url ? identify(url, title) : previousScreen;
  if (!screen) return;
  const components: ObservedComponent[] = [];
  const found: ObservedControl[] = [];
  const stack: { indent: number; componentKey?: string }[] = [];
  let truncated = false;
  for (const line of event.detail.split("\n")) {
    const match = line.match(/^(\s*)- ([a-z]+)(?: "((?:\\.|[^"])*)")?(.*)$/);
    if (!match) continue;
    const [, indentText, role, rawName = "", rest] = match;
    const indent = indentText.length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parentKey = stack[stack.length - 1]?.componentKey;
    let componentKey = parentKey;
    const label = rawName.replace(/\\"/g, '"').slice(0, 160);
    // Named groups and landmarks have observable boundaries. Generic containers
    // and unnamed lists do not identify reusable components.
    if (componentNames[role] && (label || !["region", "group", "list", "grid", "table", "article", "tabpanel"].includes(role))) {
      const functionalLabel = componentLabel(role, label);
      const reusable = ["Image gallery", "Color selector", "Size selector"].includes(functionalLabel);
      componentKey = [reusable ? undefined : parentKey, role, semanticName(functionalLabel)].filter(Boolean).join("/");
      if (!components.some(component => component.key === componentKey))
        components.push({ key: componentKey, label: functionalLabel, role, parentKey: parentKey === componentKey ? undefined : parentKey });
    }
    stack.push({ indent, componentKey });
    if (controls.has(role) && label && !rest.includes("[aria-hidden]")) {
      const key = [componentKey, role, semanticName(label)].filter(Boolean).join("/");
      if (!found.some(control => control.key === key))
        found.push({ key, label, role, componentKey, ref: rest.match(/\[ref=([^\]]+)\]/)?.[1], disabled: rest.includes("[disabled]") });
    }
    if (found.length >= 300 || components.length >= 60) { truncated = true; break; }
  }
  return { evidenceId: event.id, screen, components, controls: found, truncated };
}

export function actionLabel(event: Evidence) {
  return event.element || event.detail.match(/name:\s*(?:\\?['"])([^'"\n]+)/)?.[1]?.replace(/\\$/,"");
}

export class ExplorationInventory {
  private screens = new Map<string, {
    screen: Screen;
    controls: Map<string, ObservedControl & { status: "pending" | "exercised" | "blocked" }>;
  }>();
  private current?: InterfaceObservation;
  private refsCurrent = false;
  private recent?: ObservedControl;
  observe(event: Evidence, target?: string) {
    this.recent = undefined;
    const action = ["browser_click", "browser_type", "browser_fill_form", "browser_select_option",
      "browser_press_key", "browser_hover"].includes(event.tool);
    if (action && this.current) {
      const label = actionLabel(event);
      const matches = this.current.controls.filter(control => control.ref === target ||
        (label && semanticName(control.label) === semanticName(label)));
      if (matches.length === 1) {
        this.recent = matches[0];
        const stored = this.screens.get(this.current.screen.key)?.controls.get(matches[0].key);
        if (stored && event.tool !== "browser_hover") stored.status = event.ok ? "exercised" : "blocked";
      }
    }
    const observation = interfaceObservation(event, this.current?.screen);
    if (observation) {
      const entry = this.screens.get(observation.screen.key) ?? { screen: observation.screen, controls: new Map() };
      for (const control of observation.controls) {
        const previous = entry.controls.get(control.key);
        const status = control.disabled ? previous?.status === "exercised" ? "exercised" : "blocked" :
          previous?.disabled && previous.status === "blocked" ? "pending" : previous?.status ?? "pending";
        entry.controls.set(control.key, { ...control, status });
      }
      this.screens.set(observation.screen.key, entry);
      // Responses without an inline snapshot retain known refs for that screen.
      this.current = observation.controls.length ? observation :
        { ...observation, controls: this.current?.screen.key === observation.screen.key ? this.current.controls : [] };
      this.refsCurrent = observation.controls.length > 0;
    }
    return { observation, action: this.recent };
  }
  plan() {
    return [...this.screens.values()].map(({ screen, controls }) => ({
      screen: screen.label, route: screen.key, current: screen.key === this.current?.screen.key,
      pending: [...controls.values()].filter(control => control.status === "pending")
        .sort((a,b) => this.priority(a) - this.priority(b))
        .map(({ label, role, key }) => {
          const current = this.refsCurrent && screen.key === this.current?.screen.key ?
            this.current.controls.find(control => control.key === key) : undefined;
          return { label, role, visible: !!current, ...(current?.ref ? { ref: current.ref } : {}) };
        }),
      exercised: [...controls.values()].filter(control => control.status === "exercised").length,
      blocked: [...controls.values()].filter(control => control.status === "blocked").length,
    }));
  }
  private priority(control: ObservedControl) {
    const boundary = control.componentKey ?? "";
    return (boundary.includes("contentinfo") ? 60 : boundary.includes("banner") ? 30 : 0) +
      (control.role === "link" ? 10 : 0);
  }
}
