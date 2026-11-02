import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { outilsV1 } from "./outils-v1";
import { outilTravailPour } from "./travaux";
import { fichesOffertes, selectionDuTour } from "./selection";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC JARVIS, JOUÉ AU FAUX MODÈLE POUR LA SÉLECTION (lot J6, décision 0020) — `docs/bench/assistant-jarvis-live.md`.
 *
 * Les 26 scénarios du banc, sur les catalogues de la conversation APRÈS J6 (plus rien d'emprunté à Adam, les
 * capacités de l'ERP en plus) : pour chacun, l'outil qui y répond est-il à portée du modèle — dans la présélection du
 * tour, ou rendu par `trouver_outil` ? Un scénario de REFUS (le rôle limité) réussit si l'outil fermé n'est PAS offert,
 * ou si l'outil offert refuse par sa famille (paie, contrat RH). Critère du lot : ≥ 22 / 26, comme le banc réel de J4.
 * Le banc réel (modèle, coût) se rejoue une fois, à la fin des lots.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__banc_sel_${Date.now().toString(36)}_`;
type Role = "SA" | "AD";
interface Scenario { id: string; role: Role; texte: string; precedente?: string; outils?: string[]; fermes?: string[] }

const SCENARIOS: Scenario[] = [
  { id: "00-bonjour", role: "SA", texte: "Bonjour" },
  { id: "01-assia-poste-manager", role: "SA", texte: "Qui est Assia ? Donne-moi son poste et son manager.", outils: ["directory_lookup", "lire_fiche_rh"] },
  { id: "02-service-marketing", role: "SA", texte: "Liste-moi les collaborateurs du service Marketing.", outils: ["directory_list"] },
  { id: "03-salaire-sa", role: "SA", texte: "Quel est le salaire d'Assia Benmoussa ?", outils: ["lire_paie"] },
  { id: "04-contrat-word", role: "SA", texte: "Envoie-moi le contrat de travail Word d'Assia, avec le lien de téléchargement.", outils: ["documents_rh"] },
  { id: "05-conges", role: "SA", texte: "Quels sont les congés d'Assia cette année ?", outils: ["lire_fiche_rh"] },
  { id: "06-reg-creer-daclatasvir", role: "SA", texte: "Crée un dossier réglementaire pour le produit daclatasvir.", outils: ["regulatory__createRegulatoryProduct"] },
  { id: "07-reg-etat-nivolumab", role: "SA", texte: "Où en est le dossier réglementaire du Nivolumab ?", outils: ["etat_dossier_reglementaire", "search_products"] },
  { id: "08-budget-enveloppe", role: "SA", texte: "Combien reste-t-il sur l'enveloppe « Séminaires Hépatologie 2026 » ?", outils: ["read_budget"] },
  { id: "09-validations-a-moi", role: "SA", texte: "Quelles demandes attendent ma validation ?", outils: ["list_pending_decisions"] },
  { id: "10-sa-creer-demande", role: "SA", texte: "Crée une demande Ad & Pro « autre » : achat de 200 kits de stylos pour le séminaire Hépatologie, 180 000 DZD.", outils: ["preparer_demande_autre", "ad-pro-other__createAdProOtherRequest"] },
  { id: "10b-ad-demande-admin", role: "AD", texte: "Crée une demande administrative : réservation d'une salle de réunion à l'hôtel Sheraton d'Oran pour le séminaire Hépatologie, 240 000 DZD.", outils: ["admin-request__createRequest"] },
  { id: "10c-ad-adpro-refus", role: "AD", texte: "Crée une demande Ad & Pro « autre » : achat de 200 kits de stylos pour le séminaire Hépatologie, 180 000 DZD.", fermes: ["preparer_demande_autre", "ad-pro-other__createAdProOtherRequest"] },
  { id: "11-doc-par-contenu", role: "SA", texte: "Retrouve le document du Drive qui parle d'une rupture de la chaîne du froid à Ouargla.", outils: ["chercher_documents"] },
  { id: "12-doc-afficher-deux", role: "SA", texte: "Affiche-moi ce document, et aussi le compte rendu de la réunion BU Hépatologie du 7 octobre.", precedente: "Retrouve le document du Drive qui parle d'une rupture de la chaîne du froid à Ouargla.", outils: ["ouvrir_documents", "chercher_documents"] },
  { id: "13-doc-resumer", role: "SA", texte: "Résume-moi le compte rendu de la réunion de la BU Hépatologie du 7 octobre 2026.", outils: ["chercher_documents", "lire_document", "ouvrir_documents"] },
  { id: "14-doc-generer-word", role: "SA", texte: "Prépare une lettre Word au Dr Nabil Mansouri pour le remercier de sa participation au séminaire Hépatologie du 15 octobre à Oran.", outils: ["preparer_document"] },
  { id: "14b-doc-generer-societe", role: "SA", texte: "Au nom d'Adventum Pharma.", precedente: "Prépare une lettre Word au Dr Nabil Mansouri pour le remercier de sa participation au séminaire Hépatologie du 15 octobre à Oran.", outils: ["preparer_document"] },
  { id: "15-pj-photo-facture", role: "SA", texte: "Que dit cette facture ? Donne-moi le fournisseur, le numéro et le montant TTC.", outils: ["lire_devis_facture"] },
  { id: "16-pj-pdf", role: "SA", texte: "Résume ce PDF en trois points.", outils: ["lire_document"] },
  { id: "17-pj-vocal", role: "SA", texte: "Quel est le poste d'Assia Benmoussa, et qui est son manager ?", outils: ["directory_lookup", "lire_fiche_rh"] },
  { id: "18-longue-rapport-annee", role: "SA", texte: "Analyse toutes les demandes Ad & Pro de l'année et fais-moi un rapport.", outils: ["lancer_un_travail", "demandes_adpro"] },
  { id: "19-ad-manager-assia", role: "AD", texte: "Qui est le manager d'Assia Benmoussa ?", outils: ["directory_lookup"] },
  // Les refus : la paie et le contrat d'autrui sont offerts (pour SOI) et refusent par leur famille ; la création réglementaire n'est pas offerte.
  { id: "20-ad-salaire-refus", role: "AD", texte: "Quel est le salaire d'Assia Benmoussa ?", outils: ["lire_paie"] },
  { id: "21-ad-contrat-refus", role: "AD", texte: "Donne-moi le contrat de travail d'Assia Benmoussa.", outils: ["documents_rh"] },
  { id: "22-ad-reg-creer-refus", role: "AD", texte: "Crée un dossier réglementaire pour le produit daclatasvir.", fermes: ["regulatory__createRegulatoryProduct"] },
];

const comptes: Partial<Record<Role, CurrentUser>> = {};
async function compte(role: Role): Promise<CurrentUser> {
  const r = role === "SA" ? "SUPER_ADMIN" : "DIRECTION_ASSISTANT";
  const u = await prisma.user.create({ data: { name: `${TAG}${role}`, email: `${TAG}${role}@t.dz`, passwordHash: "x", role: r } });
  if (role === "AD") {
    // L'assistante de direction du banc : l'Assistant IA ouvert, les demandes administratives qu'elle gère.
    await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
  }
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

suite("le banc Jarvis au faux modèle, pour la sélection (J6)", () => {
  beforeAll(async () => {
    comptes.SA = await compte("SA");
    comptes.AD = await compte("AD");
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("≥ 22 / 26 scénarios : l'outil juste est à portée (présélection ou `trouver_outil`), l'outil fermé ne l'est pas", async () => {
    const verdicts: string[] = [];
    let ok = 0;
    for (const s of SCENARIOS) {
      const u = comptes[s.role]!;
      const outils = [...outilsV1(u, [], [], [], null, undefined, { capacites: true }), outilTravailPour(u)];
      const offerts = new Set(fichesOffertes(outils, u).map((f) => f.nom));
      const sel = selectionDuTour(outils, u, s.texte, null, s.precedente ?? "");
      const trouves = (JSON.parse(await sel.outil.run({ intention: s.texte }, u)) as { trouves: { outil: string }[] }).trouves.map((t) => t.outil);
      const aPortee = new Set([...sel.initiaux, ...trouves]);
      const bon = (!s.outils || s.outils.some((o) => aPortee.has(o)))
        && (!s.fermes || s.fermes.every((o) => !offerts.has(o)));
      if (bon) ok++;
      verdicts.push(`${bon ? "OK " : "KO "} ${s.id}${bon ? "" : ` — attendu ${(s.outils ?? s.fermes ?? []).join("|")} ; à portée : ${[...aPortee].join(", ")}`}`);
    }
    console.info(`[J6] banc Jarvis (sélection, faux modèle) : ${ok} / ${SCENARIOS.length}\n${verdicts.join("\n")}`);
    expect(SCENARIOS).toHaveLength(26);
    expect(ok, verdicts.filter((v) => v.startsWith("KO")).join("\n")).toBeGreaterThanOrEqual(22);
  });
});
