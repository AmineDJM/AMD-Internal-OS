import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { outilsV1 } from "./outils-v1";
import { outilTravailPour } from "./travaux";
import { fichesOffertes, selectionDuTour } from "./selection";
import { classer, OUTIL_TROUVER, PRESELECTION_MAX, SOCLE_OUTILS, TROUVES_MAX } from "../domaine/selection-outils";

/**
 * LES OUTILS CHOISIS À LA DEMANDE (J4, décision 0018) — sur les VRAIS catalogues (Super Admin, assistante de direction).
 *
 *   • le corpus de référence : 78 demandes (60 de J4, 5 de l’Atelier J3, 6 du graphe J9, 7 de « Mes notes »), l'outil juste dans les 8 premiers (`trouver_outil`) ;
 *   • jamais un outil hors droits : ni présélectionné, ni trouvé, quelle que soit la demande ;
 *   • la présélection reste petite (socle + 6) et son ordre est stable.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__sel_${Date.now().toString(36)}_`;
let sa: CurrentUser;
let ad: CurrentUser;

async function compte(nom: string, role: "SUPER_ADMIN" | "DIRECTION_ASSISTANT"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

const catalogue = (u: CurrentUser) => [...outilsV1(u, [], [], []), outilTravailPour(u)];

/** 78 demandes de référence — et les outils qui y répondent (l'un d'eux doit être dans les 8 premiers). */
export const CORPUS: [string, string[]][] = [
  ["Qui est Assia ? Donne-moi son poste et son manager.", ["directory_lookup", "lire_fiche_rh"]],
  // « Mes notes » (décision 0026) : le bloc-notes privé.
  ["Ajoute « relancer l'imprimeur » à ma liste de la semaine", ["ajouter_note"]],
  ["Ajoute « relancer l'agence de voyage » à ma page Congrès d'Oran", ["ajouter_note"]],
  ["Qu'est-ce qu'il me reste à faire dans mes notes ?", ["lire_notes"]],
  ["Coche « valider le budget » dans mes notes, c'est fait", ["cocher_note"]],
  ["Supprime la ligne sur les kakémonos de mes notes", ["supprimer_note"]],
  ["Fais-moi une nouvelle page de notes « Congrès d'Oran »", ["creer_page"]],
  ["Renomme ma page de notes « Idées » en « Idées 2027 »", ["renommer_page"]],
  // J3 — l'Atelier : modifier en place, ouvrir, convertir.
  ["Dans ce contrat, mets la période d'essai à 6 mois.", ["modifier_document"]],
  ["Remplace le titre de la présentation et ajoute une diapositive de synthèse.", ["modifier_document"]],
  ["Ouvre ce PowerPoint dans l'atelier, je veux le voir à côté.", ["ouvrir_dans_l_atelier"]],
  ["Corrige le paragraphe sur la rémunération dans le Word joint.", ["modifier_document"]],
  ["Convertis ce document Word en PDF.", ["convertir_document"]],
  ["Quel est le numéro de téléphone de Karim ?", ["directory_lookup"]],
  ["Liste-moi les collaborateurs du service Marketing.", ["directory_list"]],
  ["Quel est le salaire d'Assia Benmoussa ?", ["lire_paie"]],
  ["Combien gagne Walid en net ?", ["lire_paie"]],
  ["Envoie-moi le contrat de travail Word d'Assia, avec le lien de téléchargement.", ["documents_rh"]],
  ["Quels sont les congés d'Assia cette année ?", ["lire_fiche_rh", "read_hr_overview"]],
  ["Quel est l'effectif actuel et la masse salariale ?", ["read_hr_overview"]],
  ["Qui est le responsable hiérarchique de Nadia ?", ["lire_fiche_rh", "directory_lookup"]],
  ["Crée un dossier réglementaire pour le produit daclatasvir.", ["regulatory_operation"]],
  ["Où en est le dossier réglementaire du Nivolumab ?", ["etat_dossier_reglementaire"]],
  ["Quelles sont les réserves de l'ANPP sur le dossier REG-2026-9011 ?", ["etat_dossier_reglementaire"]],
  ["Combien de dossiers gère Amel ?", ["regulatory_workload"]],
  ["Montre-moi le portefeuille Kwality et les statuts des produits.", ["regulatory_portfolio"]],
  ["Quels sont les droits d'enregistrement à payer à l'ANPP ?", ["regulatory_knowledge"]],
  ["Confie le dossier REG-2026-9011 à Amel.", ["assign_regulatory_responsible"]],
  ["Passe l'étape dépôt du dossier REG-2026-9011 à terminée.", ["set_regulatory_step"]],
  ["Relance la mise à jour du statut du dossier REG-2026-9002.", ["request_regulatory_status_update"]],
  ["Cherche le produit sofosbuvir dans le catalogue.", ["search_products"]],
  ["Combien reste-t-il sur l'enveloppe Séminaires 2026 ?", ["read_budget"]],
  ["Quel est le total payé aux fournisseurs ce mois-ci ?", ["finance_totals"]],
  ["Quelles demandes attendent ma validation ?", ["list_pending_decisions"]],
  ["Crée une demande Ad & Pro « autre » : achat de 200 kits de stylos, 180 000 DZD.", ["preparer_demande_autre"]],
  ["Prépare une demande de sponsoring pour le Dr Mansouri au congrès de Lyon.", ["preparer_sponsoring"]],
  ["Je veux une prise en charge pour le congrès national de gastro-entérologie.", ["preparer_prise_en_charge"]],
  ["Organise un séminaire Hépatologie à Oran le 15 novembre.", ["preparer_evenement"]],
  ["Commande 500 stylos et 200 blocs-notes en matériel promotionnel.", ["preparer_materiel_promo"]],
  ["Ajoute un poste traiteur à la demande EVT-2026-14.", ["preparer_poste"]],
  ["Fais un bon de commande à partir de ce devis.", ["preparer_bc_depuis_devis"]],
  ["Ajoute ce voyageur à la billetterie depuis son passeport.", ["preparer_voyageur_passeport"]],
  ["Quel est le circuit de validation d'un sponsoring ?", ["read_workflow"]],
  ["Analyse toutes les demandes Ad & Pro de l'année et fais-moi un rapport.", ["demandes_adpro", "lancer_un_travail"]],
  ["Retrouve le document qui parle d'une rupture de la chaîne du froid à Ouargla.", ["chercher_documents"]],
  ["Résume-moi le compte rendu de la réunion BU Hépatologie du 7 octobre.", ["chercher_documents", "lire_document"]],
  ["Ouvre-moi la note sur la quarantaine du lot DCV-2609.", ["chercher_documents", "ouvrir_documents"]],
  ["Que dit cette facture ? Donne le fournisseur et le montant TTC.", ["lire_devis_facture"]],
  ["Compare les deux versions du contrat de distribution.", ["comparer_versions"]],
  ["Prépare une lettre Word au Dr Nabil Mansouri pour le remercier.", ["preparer_document"]],
  ["Traduis ce document en anglais.", ["preparer_traduction"]],
  ["Remplis ce formulaire PDF avec mes informations.", ["preparer_formulaire_pdf", "lire_formulaire_pdf"]],
  ["Quels sont les champs de ce formulaire PDF ?", ["lire_formulaire_pdf"]],
  ["Cherche le fichier « Plan marketing 2027 » dans le Drive.", ["search_drive", "chercher_documents"]],
  ["Déplace le dossier Archives 2024 dans Projets.", ["drive_operation"]],
  ["Qu'ai-je dans mon agenda demain ?", ["read_calendar"]],
  ["Fixe un rendez-vous avec Karim jeudi à 10 h.", ["preparer_rendez_vous"]],
  ["Quelles sont mes tâches en retard ?", ["list_my_tasks"]],
  ["Crée une tâche pour Walid : relancer le fournisseur avant vendredi.", ["create_task"]],
  ["Change l'échéance de la tâche « Rapport ANPP » à lundi.", ["update_task"]],
  ["Envoie un message à Karim pour lui dire que la réunion est décalée.", ["send_message"]],
  ["Réponds à Nadia dans notre conversation que c'est d'accord.", ["preparer_reponse_message"]],
  ["Ai-je des messages non lus ?", ["mes_conversations"]],
  ["Fais-moi un briefing chaque lundi à 8 h.", ["programmer_routine"]],
  ["Mets en pause ma routine du matin.", ["gerer_routine"]],
  ["Quelles routines ai-je programmées ?", ["mes_routines"]],
  ["Retiens que ma société est Pharmagène.", ["proposer_memoire"]],
  ["Quelle est l'actualité du marché de l'hépatite C en Europe ?", ["web_research"]],
  ["Où en sont mes demandes en attente de validation ? Relance le validateur.", ["mes_demandes_en_attente", "preparer_relance"]],
  ["Dépose ce justificatif sur ma demande DA-2026-31.", ["preparer_depot_piece"]],
  ["Crée une demande administrative : réservation d'une salle à l'hôtel Sheraton d'Oran.", ["create_admin_request"]],
  ["Quelle est la raison sociale confirmée du fournisseur Imprimerie Atlas ?", ["faits_confirmes"]],
  // J9 — le graphe de l'entreprise et les faits datés.
  ["Qu'est-ce qui dépend du fournisseur Saidal ?", ["explorer_relations"]],
  ["Qui a travaillé sur le dossier daclatasvir ?", ["explorer_relations"]],
  ["Quels documents parlent du sofosbuvir ?", ["explorer_relations", "chercher_documents"]],
  ["Quelle était la raison sociale de Biopharm en mars 2025 ?", ["etat_a_une_date"]],
  ["D'où vient ce chiffre du capital de Saidal ?", ["d_ou_vient"]],
  ["Quel est le capital de Saidal ?", ["etat_a_une_date", "faits_confirmes"]],
];

suite("Sélection d'outils (J4) — corpus, droits, stabilité", () => {
  beforeAll(async () => {
    sa = await compte("sa", "SUPER_ADMIN");
    ad = await compte("ad", "DIRECTION_ASSISTANT");
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("le corpus a 78 demandes, et chaque outil attendu existe au catalogue du Super Admin", () => {
    expect(CORPUS).toHaveLength(78);
    const noms = new Set(fichesOffertes(catalogue(sa), sa).map((f) => f.nom));
    for (const [, attendus] of CORPUS) for (const a of attendus) expect(noms, a).toContain(a);
  });

  it("l'outil juste est dans les 8 premiers, pour les 78 demandes (Super Admin)", () => {
    const fiches = fichesOffertes(catalogue(sa), sa);
    const rates = CORPUS.filter(([d, attendus]) => !classer(d, fiches, TROUVES_MAX).some((c) => attendus.includes(c.nom)))
      .map(([d, a]) => `${d} → ${a.join("|")} ; rendu : ${classer(d, fiches, TROUVES_MAX).map((c) => c.nom).join(", ")}`);
    expect(rates).toEqual([]);
  });

  // « Mes notes » (décision 0026) : un outil inactif est REFUSÉ par Mastra (mesuré à l'E2E) — le geste de note doit être
  // dans la PRÉSÉLECTION elle-même, pas seulement trouvable.
  it("une demande sur les notes présélectionne son geste (Super Admin)", () => {
    const fiches = fichesOffertes(catalogue(sa), sa);
    const rates = CORPUS.filter(([, a]) => a.some((n) => /_note$|_page$|^lire_notes$/.test(n)))
      .filter(([d, a]) => !classer(d, fiches, PRESELECTION_MAX).some((c) => a.includes(c.nom)))
      .map(([d, a]) => `${d} → ${a.join("|")} ; rendu : ${classer(d, fiches, PRESELECTION_MAX).map((c) => c.nom).join(", ")}`);
    expect(rates).toEqual([]);
  });

  it("jamais un outil hors droits : ni présélectionné, ni trouvé (assistante de direction, les 78 demandes)", async () => {
    const outils = catalogue(ad);
    const permis = new Set(fichesOffertes(outils, ad).map((f) => f.nom));
    const horsDroits = fichesOffertes(catalogue(sa), sa).map((f) => f.nom).filter((n) => !permis.has(n));
    expect(horsDroits.length).toBeGreaterThan(0);
    for (const [demande] of CORPUS) {
      const s = selectionDuTour(outils, ad, demande);
      expect(s.initiaux.filter((n) => n !== OUTIL_TROUVER && !permis.has(n)), demande).toEqual([]);
      const r = JSON.parse(await s.outil.run({ intention: demande }, ad)) as { trouves: { outil: string }[] };
      expect(r.trouves.map((t) => t.outil).filter((n) => !permis.has(n)), demande).toEqual([]);
      expect(s.actifs().filter((n) => n !== OUTIL_TROUVER && !permis.has(n)), demande).toEqual([]);
    }
  });

  it("une configuration de rôle qui restreint les outils restreint aussi la sélection", async () => {
    const outils = catalogue(sa);
    const s = selectionDuTour(outils, sa, "Quel est le salaire d'Assia ?", { allowedTools: ["directory_lookup", "list_my_tasks"] });
    expect(s.initiaux).toEqual([OUTIL_TROUVER, "directory_lookup", "list_my_tasks"]);
    const r = JSON.parse(await s.outil.run({ intention: "lire le salaire d'une personne" }, sa)) as { trouves: { outil: string }[] };
    expect(r.trouves.every((t) => ["directory_lookup", "list_my_tasks"].includes(t.outil))).toBe(true);
  });

  it("la présélection est petite et stable : le socle d'abord, dans son ordre, puis l'alphabet", async () => {
    const outils = catalogue(sa);
    const s = selectionDuTour(outils, sa, "Quel est le salaire d'Assia ?");
    expect(s.initiaux.length).toBeLessThanOrEqual(SOCLE_OUTILS.length + PRESELECTION_MAX);
    expect(s.initiaux.slice(0, 3)).toEqual(SOCLE_OUTILS.slice(0, 3));
    expect(s.initiaux).toContain("lire_paie");
    expect(fichesOffertes(outils, sa).length).toBeGreaterThan(s.initiaux.length * 3);
    // Un outil trouvé s'ajoute à la suite du tour, sans déranger l'ordre du socle.
    await s.outil.run({ intention: "créer un dossier réglementaire" }, sa);
    expect(s.actifs()).toContain("regulatory_operation");
    expect(s.actifs().slice(0, 3)).toEqual(SOCLE_OUTILS.slice(0, 3));
    expect(s.trouves()).toContain("regulatory_operation");
  });

  it("une relance courte hérite des outils de la question précédente (au plus 3)", () => {
    const outils = catalogue(sa);
    const seule = selectionDuTour(outils, sa, "Au nom d'Adventum Pharma.");
    expect(seule.initiaux).not.toContain("preparer_document");
    const suite = selectionDuTour(outils, sa, "Au nom d'Adventum Pharma.", null, "Prépare une lettre Word au Dr Mansouri pour le remercier.");
    expect(suite.initiaux).toContain("preparer_document");
    expect(suite.initiaux.length - seule.initiaux.length).toBeLessThanOrEqual(3);
  });

  it("une intention que rien ne couvre est dite comme un DROIT, pas comme un outil manquant", async () => {
    const s = selectionDuTour(catalogue(ad), ad, "bonjour");
    const r = JSON.parse(await s.outil.run({ intention: "zzz qwx" }, ad)) as { trouves: unknown[]; consigne: string };
    expect(r.trouves).toEqual([]);
    expect(r.consigne).toMatch(/droits/);
  });
});
