import {
  GX_FIT_SCRIPT,
  GX_FIT_STYLE,
  GX_KIT_SCRIPT,
  GX_KIT_STYLE,
  GX_PAGE_BOOTSTRAP,
  GX_THEME_STYLE,
} from "./ghostexKit.generated.ts";

/** What the parent frame and a Live page say to each other through `postMessage`. */
export const PM_PAGE_SUBMIT = "pm.page.submit";
export const PM_PAGE_RESULT = "pm.page.result";

export interface PmPageState {
  readonly answered: boolean;
  readonly answers: unknown;
  readonly answeredAt: string | null;
  /** A page without questions waits until the reader has looked at it. */
  readonly awaitsSeen: boolean;
}

// No outside requests: the page travels over the WebSocket to remote clients, so it must be
// self-contained, and an opaque-origin frame has nothing of ours to reach anyway.
const PAGE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * Stands in for Ghostex's page API (theme.rs `PAGE_API`), which the kit calls as
 * `window.ghostex`: answers go to the parent frame by `postMessage` instead of an HTTP route,
 * and drafts live for as long as the frame is open.
 */
const PAGE_API = `<script>(function(){var st=null,draft={},pending={},next=1;
function note(){if(!st||!st.answered||!document.body||document.getElementById("gx-answered"))return;var b=document.createElement("div");b.id="gx-answered";b.setAttribute("role","status");b.setAttribute("style","margin:0 0 12px;padding:8px 12px;border-radius:8px;font:500 12.5px/1.4 var(--font-sans);color:var(--success);background:color-mix(in srgb,var(--success) 12%,transparent);border:1px solid color-mix(in srgb,var(--success) 32%,transparent)");var when="";try{when=st.answeredAt?" on "+new Date(st.answeredAt).toLocaleString():"";}catch(e){}b.textContent=st.answers&&st.answers.seen===true?"Marked as seen"+when+". The project manager was told.":"Answered"+when+". The project manager has your answers.";var slot=document.querySelector("[data-gx-answered]"),kit=document.querySelector("gx-questions");if(slot)slot.appendChild(b);else if(kit){b.style.margin="0";kit.insertBefore(b,kit.firstChild);}else document.body.insertBefore(b,document.body.firstChild);}
addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.type!=="${PM_PAGE_RESULT}")return;var p=pending[d.requestId];if(!p)return;delete pending[d.requestId];if(d.ok)p.resolve(d);else p.reject(new Error(d.error||"Your answers were not sent."));});
function save(part,value){if(st&&st.answered)return;if(value==null)delete draft[part];else draft[part]=value;}
window.ghostex={get exported(){return null;},get answered(){return!!(st&&st.answered);},get awaitsSeen(){return!!(st&&st.awaitsSeen);},get answers(){return st&&st.answered?st.answers:null;},
get draft(){return draft.page===undefined?null:draft.page;},saveDraft:function(value){save("page",value===undefined?null:value);},
submit:function(answers){return new Promise(function(resolve,reject){var id=next++;pending[id]={resolve:function(j){st={answered:true,answers:answers,answeredAt:new Date().toISOString(),awaitsSeen:false};draft={};note();resolve(j);},reject:reject};parent.postMessage({type:"${PM_PAGE_SUBMIT}",requestId:id,answers:answers===undefined?null:answers},"*");});},
__draft:function(part){return draft[part]===undefined?null:draft[part];},__saveDraft:save,__pending:function(){return null;},__flush:function(){return true;},
__state:function(s){st=s;var ready=function(){note();};if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready);else ready();}};})();</script>`;

/**
 * The fork's page look, after the kit's theme and as weak as it (`:where`), so a page's own CSS
 * still wins. Light: Ghostex's light tokens (theme.rs `light_tokens!`), which the generated kit
 * lacks. Dark: a flat near-black page, like Ghostex's page window over its dimmed wallpaper.
 */
const PAGE_LOOK =
  '<style id="pm-page-look">' +
  ":where(:root[data-gx-theme=light]){color-scheme:light;--background:#f0f0f0;--foreground:#262626;--muted:#f1f1f1;--muted-foreground:#626262;--card:#ffffff;--card-foreground:#262626;--border:rgba(0,0,0,0.14);--input:rgba(0,0,0,0.16);--ring:#737373;--primary:#2563eb;--primary-foreground:#ffffff;--accent:#e9e9e9;--accent-foreground:#262626;--destructive:#b91c1c;--warning:#b45309;--success:#047857;--info:#0369a1;--code-background:#f6f8fa;--code-foreground:#1f2328;--chart-1:#2563eb;--chart-2:#d97706;--chart-3:#059669;--chart-4:#db2777;--chart-5:#7c3aed;--chart-6:#0891b2;--gx-bg:#f0f0f0;--gx-surface:rgba(255,255,255,0.55);--gx-raised:rgba(255,255,255,0.78);--gx-line:rgba(51,51,51,0.09);--gx-line-strong:rgba(51,51,51,0.15);--gx-fg:#18181b;--gx-text:#3f3f46;--gx-muted:#71717b;--gx-accent:#2563eb;--gx-warn:#a16207;--gx-good:#047857;--gx-bad:#b91c1c;--gx-code-bg:rgba(255,255,255,0.62);--gx-pick:#262626;--gx-card:rgba(255,255,255,0.62);--gx-footer:rgba(255,255,255,0.68);--gx-option:rgba(255,255,255,0.5);--gx-card-border:rgba(67,67,67,0.13);--gx-option-border:rgba(67,67,67,0.1);--gx-glass-shadow:0 14px 36px rgba(89,89,89,0.12);--gx-glass-dim:var(--gx-glass-tint-light,rgba(247,247,247,0.7));--gx-backdrop:radial-gradient(60% 50% at 85% 100%,rgba(185,185,185,0.28),transparent 70%),radial-gradient(55% 45% at 5% 0%,rgba(165,165,165,0.3),transparent 70%),linear-gradient(180deg,#f0f0f0 0%,#eeeeee 45%,#eeeeee 100%);--gx-backdrop-top:#f0f0f0;--gx-card-muted:#71717b;--gx-control:#18181b;--gx-tip-bg:rgba(252,252,252,0.78);--gx-tip-fg:#292929;--gx-tip-border:rgba(67,67,67,0.14);--gx-tip-shadow:0 10px 28px rgba(89,89,89,0.18)}" +
  ":where(:root[data-gx-theme=dark]){--background:#0e0e0f;--gx-bg:#0e0e0f;--gx-backdrop:linear-gradient(180deg,#0e0e0f 0%,#0f0f10 60%,#111112 100%);--gx-backdrop-top:#0e0e0f;--gx-card:rgba(22,22,24,0.7);--gx-footer:rgba(22,22,24,0.78);--gx-tip-bg:rgba(20,20,22,0.9)}" +
  "</style>";

/** Where a client may put a script that sets `data-gx-theme` before the kit reads it. */
export const PM_PAGE_THEME_SLOT = "<!--pm-page-theme-->";

const escapeScriptJson = (value: unknown) =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028");

/**
 * A stored page with Ghostex's page kit in front: the content policy, theme, page API bridge and
 * question kit, at the very start of `<head>` so nothing in the page runs or styles itself first.
 */
export function preparePmPage(html: string, state: PmPageState): string {
  const block = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}">`,
    PM_PAGE_THEME_SLOT,
    GX_THEME_STYLE,
    PAGE_LOOK,
    GX_PAGE_BOOTSTRAP,
    PAGE_API,
    `<script>window.ghostex.__state(${escapeScriptJson(state)});</script>`,
    GX_KIT_STYLE,
    GX_KIT_SCRIPT,
    GX_FIT_STYLE,
    GX_FIT_SCRIPT,
  ].join("");
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head)
    return `${html.slice(0, head.index + head[0].length)}${block}${html.slice(head.index + head[0].length)}`;
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root)
    return `${html.slice(0, root.index + root[0].length)}<head>${block}</head>${html.slice(root.index + root[0].length)}`;
  return `<!doctype html><html><head>${block}</head><body>${html}</body></html>`;
}

/**
 * In a native WebView the page is the top window, so the kit's `parent.postMessage` lands on the
 * page itself: this relays submissions to the app, which answers with `window.postMessage`.
 */
const NATIVE_BRIDGE = `<script>addEventListener("message",function(e){var d=e.data;if(d&&d.type==="${PM_PAGE_SUBMIT}"&&window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(d));});</script>`;

/**
 * Sets the page's theme before the kit reads it (a `srcdoc` frame has no URL fragment to carry
 * it), and for a native WebView host adds the answer relay. A web frame is a floating page: its
 * window's controls sit over the page's top band, as in Ghostex's page window.
 */
export const withPmPageTheme = (
  html: string,
  theme: "light" | "dark",
  host: "frame" | "native" = "frame",
) =>
  html.replace(
    PM_PAGE_THEME_SLOT,
    `<script>var d=document.documentElement;d.setAttribute("data-gx-theme","${theme}");${host === "frame" ? 'd.setAttribute("data-gx-floating","");' : ""}</script>${host === "native" ? NATIVE_BRIDGE : ""}`,
  );

/** True when the answers are the "Mark as seen" kind a page without questions sends. */
export const isPmPageSeen = (answers: unknown): answers is { seen: true; reply?: string } =>
  typeof answers === "object" && answers !== null && (answers as { seen?: unknown }).seen === true;
