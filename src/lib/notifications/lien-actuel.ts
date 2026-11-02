import { lienStockPromo, vueStockPromo, CHEMIN_CATALOGUE_PROMO } from "@/lib/chemins/stock-promo";
import { lienOrdreAPayer } from "@/lib/chemins/finances";

/**
 * RÉÉCRIRE LES ANCIENS LIENS DE NOTIFICATIONS — une notification est écrite UNE fois, en base, avec
 * l'adresse du jour. Les modules ont bougé depuis (Mes missions, Rapports terrain, Business Units,
 * Produits, Finances, Stock promotionnel…) : la notification d'hier pointe encore l'ancienne adresse.
 *
 * Les notifications CRÉÉES désormais pointent directement la bonne route — c'est corrigé À LA SOURCE,
 * dans les actions qui les écrivent. Ce module ne traite que les notifications DÉJÀ EN BASE : il est
 * appliqué à l'AFFICHAGE (liste, cloche, pop-up, boîte, badges de menu), jamais à l'écriture.
 *
 * La table vient de l'historique du dépôt : chaque route supprimée ou devenue page d'escale
 * (`git log --diff-filter=D`, pages `redirect(…)`). Une page d'escale redirige déjà, mais en deux
 * sauts et parfois en perdant le contexte (`/missions` menait à un écran retiré) ; une route
 * SUPPRIMÉE, elle, donnait un 404. La réécriture mène en un clic à l'écran actuel.
 *
 * Module PUR (seule importation : les adresses du stock promotionnel, pures elles aussi) : le
 * navigateur et le serveur le lisent.
 */

type Cible = { chemin: string; params?: Record<string, string> };
type Regle = {
  motif: RegExp;
  cible: (m: RegExpMatchArray, params: URLSearchParams) => Cible | string;
  /** Paramètres que la règle a lus : ils ne se recopient pas sur la nouvelle adresse. */
  consomme?: readonly string[];
  /** Module retiré : ses paramètres et son ancre ne veulent plus rien dire sur l'écran d'arrivée. */
  sansContexte?: true;
};

/** Une valeur lue par `URLSearchParams` (déjà décodée) remise dans un chemin. */
const enc = (s: string) => encodeURIComponent(s);

/**
 * LES ANCIENNES ROUTES → leurs équivalents actuels. L'ordre compte : la première règle qui
 * correspond s'applique (les chemins précis avant leurs préfixes).
 */
const REGLES: Regle[] = [
  // ── Espace personnel ──
  // « Mes missions » vivait à `/missions` ; `/missions/<id>` reste la fiche d'une mission d'Adam.
  { motif: /^\/missions$/, cible: () => "/mon-espace/missions" },
  { motif: /^\/(mon-travail|dashboard|courrier)$/, cible: () => "/mon-espace" },
  { motif: /^\/moyens-generaux\/annuaire$/, cible: () => "/mon-espace/annuaire" },
  // Adam : la mission s'ouvrait dans la conversation ; elle a sa fiche.
  { motif: /^\/assistant$/, cible: (_m, p) => (p.get("mission") ? `/missions/${enc(p.get("mission")!)}` : "/assistant"), consomme: ["mission"] },

  // ── Finances ──
  { motif: /^\/(finances|comptabilite)$/, cible: () => "/finances/paiements-a-faire" },
  { motif: /^\/finances\/ordres-de-depense$/, cible: (_m, p) => lienOrdreAPayer(p.get("focus")), consomme: ["focus"] },
  { motif: /^\/finances\/centre-de-paiement$/, cible: () => "/centre-de-paiement" },
  { motif: /^\/(finances|legal)\/factures$/, cible: () => ({ chemin: "/legal", params: { nature: "INVOICE" } }) },
  { motif: /^\/finances\/paiements$/, cible: () => "/validations/paiements" },
  { motif: /^\/finances\/paiements\/([^/]+)$/, cible: (m) => `/validations/paiements/${m[1]}` },
  { motif: /^\/finances\/bons-de-commande$/, cible: () => "/bons-de-commande" },
  { motif: /^\/finances\/paie$/, cible: () => "/rh/paie" },

  // ── RH ──
  { motif: /^\/admin\/departments$/, cible: () => "/rh/departements" },

  // ── Force de vente / Business Units / Marketing ──
  { motif: /^\/planning\/(catalogue|equipes)$/, cible: () => "/business-units" },
  { motif: /^\/planning\/business-units$/, cible: (_m, p) => (p.get("etape") === "secteurs" ? "/business-units/secteurs" : "/business-units"), consomme: ["etape"] },
  { motif: /^\/planning\/parametres$/, cible: () => "/business-units/parametres" },
  { motif: /^\/planning\/pilotage$/, cible: () => "/planning" },
  { motif: /^\/planning\/affectations$/, cible: () => "/planning/produits" },
  { motif: /^\/(planning|marketing-cockpit)\/messages$/, cible: () => ({ chemin: "/marketing-cockpit", params: { vue: "messages" } }) },
  { motif: /^\/(planning|marketing-cockpit)\/specialites$/, cible: () => "/annuaires/specialites" },
  { motif: /^\/medical\/etablissements$/, cible: () => "/annuaires/etablissements" },
  // Les rapports terrain sont un onglet de la Promotion médicale (07/10) — fiche, aperçu, PV compris.
  { motif: /^\/field-reports(\/.*)?$/, cible: (m) => `/medical/rapports${m[1] ?? ""}` },

  // ── Produits / Regulatory / Business development ──
  { motif: /^\/regulatory\/catalogue$/, cible: () => "/produits" },
  { motif: /^\/regulatory\/catalogue\/([^/]+)$/, cible: (m) => ({ chemin: `/produits/${m[1]}`, params: { onglet: "reglementaire" } }) },
  { motif: /^\/regulatory\/requests(\/[^/]+)?$/, cible: () => "/regulatory", sansContexte: true },
  { motif: /^\/business-development\/pipeline$/, cible: () => "/regulatory/pipeline" },
  { motif: /^\/business-development\/marche\/produits$/, cible: () => "/explorateur-produits" },

  // ── Stock promotionnel (sous-module à part, §118.173) ──
  { motif: /^\/promo-material\/catalogue$/, cible: () => CHEMIN_CATALOGUE_PROMO },
  { motif: /^\/promo-material\/stock$/, cible: (_m, p) => lienStockPromo(vueStockPromo(p.get("vue"))), consomme: ["vue"] },

  // ── Modules retirés ──
  // « Retours & réclamations » a été retiré (10/2026) : ses notifications n'ont plus d'écran — l'espace
  // personnel plutôt qu'un 404.
  { motif: /^\/retours-reclamations(\/.*)?$/, cible: () => "/mon-espace", sansContexte: true },

  // ── Divers ──
  { motif: /^\/office$/, cible: () => "/drive" },
  { motif: /^\/process-intelligence\/people$/, cible: () => ({ chemin: "/process-intelligence", params: { vue: "personnes" } }) },
  { motif: /^\/admin\/organigramme$/, cible: () => "/organigramme" },
  { motif: /^\/annuaires\/autres$/, cible: () => "/annuaires/fournisseurs" },
];

/**
 * Réécrit un lien de notification vers sa destination actuelle, ou le rend tel quel quand il est
 * déjà valide. `null` pour un lien vide. Un lien externe (`https://…`) n'est jamais touché.
 */
export function reécriteLienNotification(lien: string | null | undefined): string | null {
  if (!lien) return null;
  if (!lien.startsWith("/") || lien.startsWith("//")) return lien;

  let url: URL;
  try {
    url = new URL(lien, "http://localhost");
  } catch {
    return lien;
  }
  const chemin = url.pathname.replace(/\/+$/, "") || "/";
  const params = new URLSearchParams(url.search);
  let hash = url.hash;

  let cheminActuel = chemin;
  for (const r of REGLES) {
    const m = chemin.match(r.motif);
    if (!m) continue;
    const res = r.cible(m, params);
    for (const k of r.consomme ?? []) params.delete(k);
    if (r.sansContexte) {
      for (const k of [...params.keys()]) params.delete(k);
      hash = "";
    }
    if (typeof res === "string") {
      // La cible peut porter ses propres paramètres et son ancre (ex. `?focus=…#ord-…`).
      const u = new URL(res, "http://localhost");
      cheminActuel = u.pathname;
      u.searchParams.forEach((v, k) => params.set(k, v));
      if (u.hash && !hash) hash = u.hash;
    } else {
      cheminActuel = res.chemin;
      for (const [k, v] of Object.entries(res.params ?? {})) params.set(k, v);
    }
    break;
  }

  // Paramètre renommé : la file des demandes RH ouvre une demande par `?demande=`.
  if (cheminActuel === "/rh/demandes" && params.has("id")) {
    const valeur = params.get("id");
    params.delete("id");
    if (valeur) params.set("demande", valeur);
  }

  const paramsStr = params.toString();
  return cheminActuel + (paramsStr ? `?${paramsStr}` : "") + hash;
}
