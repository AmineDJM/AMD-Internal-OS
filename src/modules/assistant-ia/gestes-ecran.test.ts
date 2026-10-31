import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOGUE_EXPORTS } from "@/lib/exports/catalogue";
import { OUTILS_OUVERTS, OUTILS_PRODUITS } from "@/lib/exports/producteurs";
import { FICHES_EXPORTS, MOTS_EXPORTS } from "./infra/exports";
import { registreDesCapacites } from "./infra/capacites";
import { OPERATIONS_IA } from "./infra/operations";
import { classer, type FicheOutil } from "./domaine/selection-outils";
import { ecransPour } from "./infra/selection";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIQUET DES GESTES D'ÉCRAN HORS ACTIONS (lot K7, décision 0037).
 *
 * Le registre des capacités (J6) dérive des ACTIONS SERVEUR. Mais un écran agit aussi par des ROUTES (`src/app/api/…`) :
 * exports, téléchargements, PDF, téléversements. Invisibles pour l'assistant, elles lui faisaient dire « je ne peux
 * pas » devant un geste que l'écran fait (Direction, 31/10/2026). Chaque route — méthodes comprises — est CLASSÉE ici :
 *   • COUVERT — l'assistant le fait déjà, par l'outil nommé ;
 *   • EXPOSE  — exposé par ce lot (un export du catalogue, ou la pièce jointe d'un message) ;
 *   • HORS    — volontairement hors de l'assistant, avec la raison.
 *
 * Le test relit `src/app/api` : une route NOUVELLE (ou une méthode nouvelle) qui n'est pas classée ici fait échouer
 * `npm test`, et la décision 0037 doit la nommer. Les exports exposés sont exactement ceux du catalogue, chacun avec son
 * producteur, sa porte, sa fiche au registre et ses mots à la sélection.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
type ClasseGeste = "COUVERT" | "EXPOSE" | "HORS";

interface GesteEcran {
  /** Les méthodes HTTP de la route, triées (`GET,POST`). */
  methodes: string;
  classe: ClasseGeste;
  /** L'outil de l'assistant qui le fait (COUVERT, EXPOSE). */
  par?: string;
  /** Pourquoi il reste hors de l'assistant (HORS), ou ce que l'outil en reprend. */
  raison?: string;
}

const TELEVERSEMENT = "plomberie d'un téléversement (sessions, morceaux, URL signées) : un fichier glissé dans la conversation passe par le dépôt de l'assistant";
const FLUX = "flux de lecture d'un écran (liste, rafraîchissement, sélecteur) : l'assistant lit l'ERP par ses propres lectures";
const ENTRANT = "appel entrant d'un service externe (webhook, rappel OAuth) : aucune personne derrière";
const TECHNIQUE = "route technique (santé, diagnostic, réglage du navigateur, image) : rien à demander à l'assistant";
const TELEMETRIE = "télémétrie ou signal de sécurité de l'écran";
const ADAM = "Adam, le Chief of Staff : produit séparé, l'Assistant IA ne l'emprunte pas (décision 0013)";
const PROPRE = "plomberie de l'Assistant IA lui-même";
const API_V1 = "API publique v1 (jetons d'intégration) : un client externe, pas un écran";
const SITE_WEB = "API du site web public : visiteurs et candidats, pas un écran de l'ERP";
const ONLYOFFICE = "éditeur en ligne (OnlyOffice) : session et enregistrement de l'éditeur ouvert ; l'assistant retouche par l'Atelier";
const PIECE_DE_FIL = "pièce d'un fil (message, dossier, retour) : elle s'ouvre là où le fil la porte, sous ses droits ; l'assistant lit les pièces jointes à SA conversation";
const ARCHIVE = "archive ZIP d'un dossier entier : un téléchargement d'écran, sans contenu à lire ni à envoyer (l'assistant joint les fichiers eux-mêmes)";

const INVENTAIRE_GESTES_ECRAN: Readonly<Record<string, GesteEcran>> = {
  // ── Les exports de l'ERP — exposés par ce lot (catalogue `lib/exports/catalogue.ts`) ──────────────
  "/api/regulatory/export": { methodes: "POST", classe: "EXPOSE", par: "exporter_suivi_regulatory" },
  "/api/budgets/export": { methodes: "GET", classe: "EXPOSE", par: "exporter_budget" },
  "/api/budgets/marketing/export": { methodes: "GET", classe: "EXPOSE", par: "exporter_budget_marketing" },
  "/api/planning/export": { methodes: "GET", classe: "EXPOSE", par: "exporter_pilotage_force_de_vente" },
  "/api/pch/export": { methodes: "GET", classe: "EXPOSE", par: "exporter_appel_d_offres_pch" },
  "/api/segmentation/export": { methodes: "GET", classe: "EXPOSE", par: "exporter_segmentation" },
  "/api/stocks/demandes/[id]/export": { methodes: "GET", classe: "EXPOSE", par: "exporter_demande_stocks" },
  "/api/events/[id]/export": { methodes: "GET", classe: "EXPOSE", par: "exporter_inscrits_evenement" },
  "/api/market-research/[id]/export": { methodes: "GET", classe: "EXPOSE", par: "exporter_etude_de_marche" },
  "/api/market-research/presentation/[versionId]": { methodes: "GET", classe: "EXPOSE", par: "exporter_presentation_etude" },
  "/api/medical/coaching/export": { methodes: "GET", classe: "EXPOSE", par: "exporter_suivi_coaching" },
  "/api/medical/coaching/[id]/export": { methodes: "GET", classe: "EXPOSE", par: "exporter_fiche_coaching" },
  "/api/medical/annuaire/export": { methodes: "GET", classe: "EXPOSE", par: "exporter_annuaire" },
  "/api/medical/plan-de-tournee/[id]/pdf": { methodes: "GET", classe: "EXPOSE", par: "exporter_plan_de_tournee_pdf" },
  // Joindre un fichier à un message : la pièce du Drive, par la carte d'envoi (`send_message`, `driveRefs`).
  "/api/messaging/upload": { methodes: "POST", classe: "EXPOSE", par: "send_message", raison: "joindre un fichier à un message : l'assistant joint une pièce du Drive (un export, un document), carte à confirmer" },

  // ── Déjà couverts par un outil ────────────────────────────────────────────────────────────────────────
  "/api/search": { methodes: "GET", classe: "COUVERT", par: "search_everything" },
  "/api/drive/[id]/raw": { methodes: "GET", classe: "COUVERT", par: "ouvrir_documents", raison: "l'assistant rend le lien du fichier (`/drive/<id>`, téléchargement `?dl=1`)" },
  "/api/drive/[id]/texte": { methodes: "GET", classe: "COUVERT", par: "lire_document" },
  "/api/drive/[id]/texte/enregistrer": { methodes: "POST", classe: "COUVERT", par: "enregistrer_document" },
  "/api/documents/[id]": { methodes: "GET", classe: "COUVERT", par: "ouvrir_documents" },
  "/api/documents/[id]/texte": { methodes: "GET", classe: "COUVERT", par: "lire_document" },
  "/api/documents/[id]/texte/enregistrer": { methodes: "POST", classe: "COUVERT", par: "enregistrer_document" },
  "/api/rh/document/[id]": { methodes: "GET", classe: "COUVERT", par: "documents_rh" },
  "/api/field-reports/[id]/transcribe": { methodes: "POST", classe: "COUVERT", par: "terrain_compte_rendu" },
  "/api/field-reports/[id]/upload": { methodes: "POST", classe: "COUVERT", par: "terrain_piece_visite" },

  // ── Volontairement hors de l'assistant ────────────────────────────────────────────────────────────────
  "/api/prises-en-charge/livret": { methodes: "POST", classe: "HORS", raison: "génère ET range le livret de séjour dans les pièces de la demande, voyageur choisi à l'écran « Billets et confirmations » : un geste d'écriture qui reste au bouton" },
  "/api/regulatory/intelligence/process": { methodes: "POST", classe: "HORS", raison: "lance l'analyse lourde d'un dossier CTD (OCR, extraction) depuis l'écran Enregistrement ; l'assistant lit le résultat (lire_dossier_depose, etat_dossier_reglementaire)" },
  "/api/regulatory/intelligence/document/[documentId]": { methodes: "GET", classe: "HORS", raison: "pièce d'un dossier CTD analysé : servie à l'écran Enregistrement ; l'assistant en lit l'état (etat_dossier_reglementaire)" },
  "/api/regulatory/intelligence/generated/[docId]": { methodes: "GET", classe: "HORS", raison: "document généré par l'analyse d'un dossier CTD : servi à l'écran Enregistrement" },
  "/api/regulatory/intelligence/version/[versionId]/original": { methodes: "GET", classe: "HORS", raison: ARCHIVE },
  "/api/regulatory/intelligence/progress/[versionId]": { methodes: "GET", classe: "HORS", raison: FLUX },
  "/api/regulatory/intelligence/ocr/diagnose": { methodes: "GET", classe: "HORS", raison: TECHNIQUE },
  "/api/regulatory/intelligence/upload/diagnose": { methodes: "GET", classe: "HORS", raison: TECHNIQUE },
  "/api/regulatory/intelligence/upload": { methodes: "POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/regulatory/intelligence/reserves/upload": { methodes: "POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/regulatory/intelligence/upload/direct/[sessionId]/finalize": { methodes: "POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/regulatory/intelligence/upload/session": { methodes: "POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/regulatory/intelligence/upload/session/[sessionId]": { methodes: "DELETE,GET", classe: "HORS", raison: TELEVERSEMENT },
  "/api/regulatory/intelligence/upload/session/[sessionId]/finalize": { methodes: "POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/regulatory/intelligence/upload/session/[sessionId]/part": { methodes: "PUT", classe: "HORS", raison: TELEVERSEMENT },
  "/api/drive/upload": { methodes: "POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/drive/upload/claim": { methodes: "POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/drive/upload/direct": { methodes: "POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/drive/upload/direct/[id]": { methodes: "DELETE,GET,POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/documents/upload": { methodes: "POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/documents/upload/direct": { methodes: "POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/documents/upload/direct/[id]": { methodes: "DELETE,GET,POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/rh/upload": { methodes: "POST", classe: "HORS", raison: TELEVERSEMENT },
  "/api/meetings/[id]/recording": { methodes: "POST", classe: "HORS", raison: "enregistrement d'une réunion vidéo, envoyé par le navigateur pendant l'appel" },
  "/api/drive/[id]/zip": { methodes: "GET", classe: "HORS", raison: ARCHIVE },
  "/api/drive/zip": { methodes: "GET", classe: "HORS", raison: ARCHIVE },
  "/api/documents/[id]/zip": { methodes: "GET", classe: "HORS", raison: ARCHIVE },
  "/api/messaging/attachment/[id]": { methodes: "GET", classe: "HORS", raison: PIECE_DE_FIL },
  "/api/meetings/message-attachment/[id]": { methodes: "GET", classe: "HORS", raison: PIECE_DE_FIL },
  "/api/dossiers/message-attachment/[id]": { methodes: "GET", classe: "HORS", raison: PIECE_DE_FIL },
  "/api/feedback/attachment/[id]": { methodes: "GET", classe: "HORS", raison: PIECE_DE_FIL },
  "/api/field-reports/attachment/[id]": { methodes: "GET", classe: "HORS", raison: PIECE_DE_FIL },
  "/api/kpi/piece/[id]": { methodes: "GET", classe: "HORS", raison: "justificatif d'un indicateur : il s'ouvre depuis la fiche KPI, sous ses droits" },
  "/api/legal/[id]/fichier": { methodes: "GET", classe: "HORS", raison: "pièce juridique (contrat, statuts) : elle s'ouvre depuis la fiche Juridique, sous les droits du module ; la Bibliothèque la retrouve si elle y est inscrite" },
  "/api/ventes-pch/fichier/[id]": { methodes: "GET", classe: "HORS", raison: "fichier importé des ventes PCH : servi à l'écran d'import, sous ses droits" },
  "/api/site-web/candidatures/[id]/cv": { methodes: "GET", classe: "HORS", raison: "CV d'un candidat : pièce RH sensible, ouverte à l'écran Recrutement seulement" },
  "/api/events/qr/[token]": { methodes: "GET", classe: "HORS", raison: "QR d'un badge d'inscription : affiché et scanné à l'accueil de l'événement" },
  "/api/events/inbound/[source]": { methodes: "POST", classe: "HORS", raison: ENTRANT },
  "/api/mail/inbound": { methodes: "POST", classe: "HORS", raison: ENTRANT },
  "/api/google/callback": { methodes: "GET", classe: "HORS", raison: ENTRANT },
  "/api/google/connect": { methodes: "GET", classe: "HORS", raison: ENTRANT },
  "/api/google/pubsub": { methodes: "POST", classe: "HORS", raison: ENTRANT },
  "/api/mail/ms/callback": { methodes: "GET", classe: "HORS", raison: ENTRANT },
  "/api/mail/ms/connect": { methodes: "GET", classe: "HORS", raison: ENTRANT },
  "/api/onlyoffice/callback": { methodes: "POST", classe: "HORS", raison: ONLYOFFICE },
  "/api/onlyoffice/file": { methodes: "GET", classe: "HORS", raison: ONLYOFFICE },
  "/api/onlyoffice/session": { methodes: "GET", classe: "HORS", raison: ONLYOFFICE },
  "/api/mail/attachment": { methodes: "GET", classe: "HORS", raison: "boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA" },
  "/api/mail/contacts": { methodes: "GET", classe: "HORS", raison: "boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA" },
  "/api/mail/message": { methodes: "GET", classe: "HORS", raison: "boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA" },
  "/api/mail/messages": { methodes: "GET", classe: "HORS", raison: "boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA" },
  "/api/mail/ms/attachment": { methodes: "GET", classe: "HORS", raison: "boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA" },
  "/api/mail/ms/data": { methodes: "GET", classe: "HORS", raison: "boîte mail personnelle (Google / Microsoft) : hors du périmètre de l'Assistant IA" },
  "/api/messaging/bookmarks": { methodes: "GET", classe: "HORS", raison: FLUX },
  "/api/messaging/conversation": { methodes: "GET", classe: "HORS", raison: FLUX },
  "/api/messaging/messages": { methodes: "GET", classe: "HORS", raison: FLUX },
  "/api/messaging/sync": { methodes: "GET", classe: "HORS", raison: FLUX },
  "/api/messaging/typing": { methodes: "POST", classe: "HORS", raison: "indicateur « en train d'écrire » de la messagerie" },
  "/api/notifications/poll": { methodes: "GET", classe: "HORS", raison: FLUX },
  "/api/annuaire/parties": { methodes: "GET", classe: "HORS", raison: FLUX },
  "/api/admin/audit": { methodes: "GET", classe: "HORS", raison: FLUX },
  "/api/consommation/modele": { methodes: "GET", classe: "HORS", raison: FLUX },
  "/api/artifact/[id]/image/[imageId]": { methodes: "GET", classe: "HORS", raison: "aperçu d'un document ouvert dans l'Atelier (image d'une page)" },
  "/api/artifact/[id]/page/[n]": { methodes: "GET", classe: "HORS", raison: "aperçu d'un document ouvert dans l'Atelier (une page)" },
  "/api/push/key": { methodes: "GET", classe: "HORS", raison: TECHNIQUE },
  "/api/push/subscribe": { methodes: "DELETE,POST", classe: "HORS", raison: TECHNIQUE },
  "/api/health": { methodes: "GET", classe: "HORS", raison: TECHNIQUE },
  "/api/health/worker": { methodes: "GET", classe: "HORS", raison: TECHNIQUE },
  "/api/uploads/limites": { methodes: "GET", classe: "HORS", raison: TECHNIQUE },
  "/api/marque/[companyId]/logo": { methodes: "GET", classe: "HORS", raison: TECHNIQUE },
  "/api/admin/mail-diagnostic": { methodes: "POST", classe: "HORS", raison: TECHNIQUE },
  "/api/admin/storage/cors-test": { methodes: "DELETE,PATCH,POST", classe: "HORS", raison: TECHNIQUE },
  "/api/admin/storage/self-test": { methodes: "POST", classe: "HORS", raison: TECHNIQUE },
  "/api/activity": { methodes: "POST", classe: "HORS", raison: TELEMETRIE },
  "/api/replay": { methodes: "POST", classe: "HORS", raison: TELEMETRIE },
  "/api/security/screenshot-attempt": { methodes: "POST", classe: "HORS", raison: TELEMETRIE },
  "/api/auth/[...nextauth]": { methodes: "", classe: "HORS", raison: "connexion et session (NextAuth) : se connecter reste un geste de la personne" },
  "/api/assistant-ia/atelier": { methodes: "GET", classe: "HORS", raison: PROPRE },
  "/api/assistant-ia/depot-dossier": { methodes: "GET,POST", classe: "HORS", raison: PROPRE },
  "/api/assistant-ia/depot-dossier/[id]": { methodes: "PATCH", classe: "HORS", raison: PROPRE },
  "/api/assistant-ia/fil": { methodes: "GET", classe: "HORS", raison: PROPRE },
  "/api/assistant-ia/terrain": { methodes: "GET,POST", classe: "HORS", raison: PROPRE },
  "/api/assistant-ia/vocal": { methodes: "POST", classe: "HORS", raison: PROPRE },
  "/api/assistant-ia/voix/delegation": { methodes: "POST", classe: "HORS", raison: PROPRE },
  "/api/assistant-ia/voix/journal": { methodes: "POST", classe: "HORS", raison: PROPRE },
  "/api/assistant-ia/voix/session": { methodes: "POST", classe: "HORS", raison: PROPRE },
  "/api/assistant/stream": { methodes: "POST", classe: "HORS", raison: ADAM },
  "/api/assistant/transcribe": { methodes: "POST", classe: "HORS", raison: ADAM },
  "/api/assistant/voice/log": { methodes: "POST", classe: "HORS", raison: ADAM },
  "/api/assistant/voice/session": { methodes: "POST", classe: "HORS", raison: ADAM },
  "/api/assistant/voice/tool": { methodes: "POST", classe: "HORS", raison: ADAM },
  "/api/assistant/voice/turn": { methodes: "POST", classe: "HORS", raison: ADAM },
  "/api/site-web/v1/audience.js": { methodes: "GET", classe: "HORS", raison: SITE_WEB },
  "/api/site-web/v1/audience": { methodes: "POST", classe: "HORS", raison: SITE_WEB },
  "/api/site-web/v1/candidatures": { methodes: "POST", classe: "HORS", raison: SITE_WEB },
  "/api/site-web/v1/contenus": { methodes: "GET", classe: "HORS", raison: SITE_WEB },
  "/api/v1/documents/[id]/content": { methodes: "GET", classe: "HORS", raison: API_V1 },
  "/api/v1/entities/[entity]": { methodes: "GET", classe: "HORS", raison: API_V1 },
  "/api/v1/entities/[entity]/[id]": { methodes: "GET", classe: "HORS", raison: API_V1 },
  "/api/v1/entities/[entity]/[id]/[aspect]": { methodes: "GET", classe: "HORS", raison: API_V1 },
  "/api/v1/meta/entities": { methodes: "GET", classe: "HORS", raison: API_V1 },
  "/api/v1/meta/entities/[entity]": { methodes: "GET", classe: "HORS", raison: API_V1 },
  "/api/v1/meta/modules": { methodes: "GET", classe: "HORS", raison: API_V1 },
  "/api/v1/meta/operations": { methodes: "GET", classe: "HORS", raison: API_V1 },
  "/api/v1/openapi.json": { methodes: "GET", classe: "HORS", raison: API_V1 },
  "/api/v1/operations/[operation]": { methodes: "POST", classe: "HORS", raison: API_V1 },
  "/api/v1/search": { methodes: "GET", classe: "HORS", raison: API_V1 },
};

const RACINE = process.cwd();
const API = join(RACINE, "src/app/api");

function routes(dir = API): Map<string, string> {
  const out = new Map<string, string>();
  for (const nom of readdirSync(dir)) {
    const chemin = join(dir, nom);
    if (statSync(chemin).isDirectory()) for (const [k, v] of routes(chemin)) out.set(k, v);
    else if (nom === "route.ts") {
      const src = readFileSync(chemin, "utf8");
      const methodes = [...new Set([...src.matchAll(/export (?:async )?(?:function|const) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!))].sort().join(",");
      out.set(`/api${dir.slice(API.length).split("\\").join("/")}`, methodes);
    }
  }
  return out;
}

const reelles = routes();
const decision = readFileSync(join(RACINE, "docs/assistant/decisions/0037-exports-et-gestes-d-ecran.md"), "utf8");

describe("K7 — l'inventaire des gestes d'écran hors actions", () => {
  it("chaque route de src/app/api est classée, avec ses méthodes exactes (une route nouvelle se classe ici)", () => {
    const nonClassees = [...reelles.keys()].filter((r) => !INVENTAIRE_GESTES_ECRAN[r]);
    expect(nonClassees, "classer ces routes dans modules/assistant-ia/domaine/gestes-ecran.ts (et la décision 0037)").toEqual([]);
    const disparues = Object.keys(INVENTAIRE_GESTES_ECRAN).filter((r) => !reelles.has(r));
    expect(disparues, "routes supprimées : les retirer de l'inventaire").toEqual([]);
    const methodes = [...reelles].filter(([r, m]) => INVENTAIRE_GESTES_ECRAN[r]!.methodes !== m).map(([r, m]) => `${r} : ${m}`);
    expect(methodes, "méthodes nouvelles : reclasser la route").toEqual([]);
  });

  it("la décision 0037 nomme chaque route classée", () => {
    expect(Object.keys(INVENTAIRE_GESTES_ECRAN).filter((r) => !decision.includes(`\`${r}\``))).toEqual([]);
  });

  it("un geste HORS dit pourquoi ; un geste COUVERT ou EXPOSÉ nomme un outil qui existe", () => {
    const outils = new Set([
      ...CATALOGUE_EXPORTS.map((f) => f.outil), ...OPERATIONS_IA.map((o) => o.nom),
      "search_everything", "ouvrir_documents", "lire_document", "enregistrer_document", "documents_rh", "terrain_compte_rendu", "terrain_piece_visite",
    ]);
    for (const [r, g] of Object.entries(INVENTAIRE_GESTES_ECRAN)) {
      if (g.classe === "HORS") expect(g.raison?.length ?? 0, r).toBeGreaterThan(20);
      else expect(outils.has(g.par ?? ""), `${r} → ${g.par}`).toBe(true);
    }
  });

  it("les exports exposés sont exactement ceux du catalogue, et chaque fiche du catalogue pointe sa route", () => {
    const exposes = Object.entries(INVENTAIRE_GESTES_ECRAN).filter(([, g]) => g.classe === "EXPOSE" && g.par?.startsWith("exporter_"));
    expect(exposes.map(([r, g]) => `${r} ${g.par}`).sort()).toEqual(CATALOGUE_EXPORTS.map((f) => `${f.route} ${f.outil}`).sort());
    expect([...OUTILS_PRODUITS].sort()).toEqual(CATALOGUE_EXPORTS.map((f) => f.outil).sort());
    expect([...OUTILS_OUVERTS].sort()).toEqual(CATALOGUE_EXPORTS.map((f) => f.outil).sort());
  });

  it("chaque route d'export appelle SA fonction partagée (aucune logique propre : ni prisma, ni droits)", () => {
    for (const f of CATALOGUE_EXPORTS) {
      const src = readFileSync(join(RACINE, "src/app", f.route, "route.ts"), "utf8");
      expect(src, f.route).toMatch(/reponseExport\(/);
      expect(src, f.route).not.toMatch(/@\/lib\/prisma|userCan\(|recordAudit\(/);
    }
  });
});

describe("K7 — les exports au registre des capacités et à la sélection d'outils", () => {
  it("une fiche par export au registre : lecture, familles Drive (+ domaine), libellé français", () => {
    const r = registreDesCapacites();
    for (const f of CATALOGUE_EXPORTS) {
      const c = r.parOutil.get(f.outil);
      expect(c, f.outil).toBeDefined();
      expect(c!.risque).toBe("R0");
      expect(c!.familles).toContain("DRIVE");
      expect(c!.libelle).toBe(f.libelle);
    }
    expect(FICHES_EXPORTS).toHaveLength(CATALOGUE_EXPORTS.length);
  });

  const fiches: FicheOutil[] = CATALOGUE_EXPORTS.map((f) => ({ nom: f.outil, libelle: f.libelle, description: f.description, ...MOTS_EXPORTS.get(f.outil) }));
  it.each([
    ["Envoie à Amine Djouamai l'Excel du suivi Regulatory.", "exporter_suivi_regulatory"],
    ["Génère le suivi Regulatory en Excel", "exporter_suivi_regulatory"],
    ["Exporte le budget marketing en PDF", "exporter_budget_marketing"],
    ["Sors-moi l'annuaire des pharmaciens en Excel", "exporter_annuaire"],
    ["Le PDF de mon plan de tournée de novembre", "exporter_plan_de_tournee_pdf"],
    ["Exporte le suivi du coaching", "exporter_suivi_coaching"],
    ["La liste des inscrits du congrès d'Oran en CSV", "exporter_inscrits_evenement"],
  ])("« %s » → %s en tête", (demande, attendu) => {
    expect(classer(demande, fiches, 3)[0]?.nom).toBe(attendu);
  });

  it("quand rien ne couvre l'intention, trouver_outil nomme l'écran et son lien", () => {
    const e = ecransPour("exporter le suivi regulatory en excel");
    expect(e[0]?.lien).toBe("/regulatory");
  });
});
