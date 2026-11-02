/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'AUDIT — LES TÂCHES DU LOT T2 : ANNUAIRES (ANN-), MARKETING (MKT-), TERRAIN (TER-). Décision 0051.
 *
 * « Il faut aussi qu'il soit capable d'analyser le marketing, modifier les annuaires, il peut avoir des tâches longues
 * à faire sur l'annuaire, il peut demander aux délégués ou à des gens les stocks etc. et des trucs précis de tout
 * genre » (Direction, 02/11).
 *
 * Chaque tâche porte un VÉRIFICATEUR déterministe : il relit la BASE (la fiche corrigée, la fusion faite, la mission et
 * ses demandes, la visite enregistrée) ou recalcule en base le chiffre attendu et le cherche dans la réponse — jamais
 * la parole de l'assistant. Les fiches modifiées sont remises dans leur état initial par `preparer`.
 * Variété : simples, précises, multi-étapes, en lot depuis un Excel, longues (mission), ambiguës (une question au
 * plus), annulation par lot, refus propres (hors secteur, sans droit), lectures « trucs précis ».
 *
 * Pur : aucun import de la base (le banc passe `db`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import type { ContexteVerif, Tache } from "../taches";
import { normaliser } from "../verdicts";
import { INITIAL, TEMOIN_VISITE } from "./annuaire-marketing-donnees";

const chiffres = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const T2 = (c: ContexteVerif) => {
  if (!c.s.t2) throw new Error("semis T2 absent : ressemer le banc");
  return c.s.t2;
};
/** Le nombre `n` (entier) apparaît-il dans le texte — milliers recollés (« 640 000 », « 640.000 », « 640000 ») ? */
export function contientNombre(texte: string, n: number): boolean {
  return new RegExp(`(?<!\\d)${Math.round(n)}(?!\\d)`).test(normaliser(texte));
}
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
/** Une date dite dans la réponse : 28/10, 28-10-2026, 2026-10-28 ou « 28 octobre ». */
export function contientDate(texte: string, d: Date): boolean {
  const j = d.getUTCDate();
  const m = d.getUTCMonth() + 1;
  const p2 = (x: number) => String(x).padStart(2, "0");
  return [`${p2(j)}/${p2(m)}`, `${j}/${m}`, `${p2(j)}-${p2(m)}`, `${d.getUTCFullYear()}-${p2(m)}-${p2(j)}`].some((x) => texte.includes(x))
    || new RegExp(`\\b${j}(er)?\\s+${MOIS[m - 1]}`, "i").test(texte);
}
const debutAnnee = () => new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
const debutMois = (decalage = 0) => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - decalage, 1)); };

/** Les dépenses Ad & Pro (sponsorings demandés + « autres ») depuis `du`, par une clé — la base de calcul du semis. */
async function depenses(c: ContexteVerif, du: Date, au: Date | null, cle: "bu" | "produit"): Promise<Map<string, number>> {
  const quand = { gte: du, ...(au ? { lt: au } : {}) };
  const [sp, au2] = await Promise.all([
    c.db.sponsoringRequest.findMany({ where: { createdAt: quand }, select: { amountRequested: true, product: true, businessUnit: { select: { name: true } } } }),
    c.db.adProOtherRequest.findMany({ where: { createdAt: quand }, select: { amount: true, product: true, businessUnit: { select: { name: true } } } }),
  ]);
  const out = new Map<string, number>();
  const ajouter = (k: string | null | undefined, v: unknown) => { if (!k || v == null) return; out.set(k, (out.get(k) ?? 0) + Number(v)); };
  for (const r of sp) ajouter(cle === "bu" ? r.businessUnit?.name : r.product, r.amountRequested);
  for (const r of au2) ajouter(cle === "bu" ? r.businessUnit?.name : r.product, r.amount);
  return out;
}

/** La mission ouverte par la persona pendant le tour, et ses étapes (sérialisées pour y chercher DEMANDE, LIVRABLE…). */
async function missionDuTour(c: ContexteVerif): Promise<{ titre: string; etapes: string } | null> {
  const m = await c.db.mission.findFirst({ where: { ownerId: c.userId, createdAt: { gte: c.t0 }, kind: "TRAVAIL" }, orderBy: { createdAt: "desc" }, select: { id: true, title: true, objective: true, context: true } });
  if (!m) return null;
  const steps = await c.db.missionStep.findMany({ where: { missionId: m.id }, select: { key: true, title: true, nodeType: true, capability: true, input: true, spec: true, forEach: true } });
  return { titre: m.title, etapes: JSON.stringify({ objective: m.objective, context: m.context, steps }) };
}

/** Une demande adressée à une personne, prête dans le plan d'une mission (DEMANDE) ou déjà déposée (`TravailDemande`). */
async function demandeA(c: ContexteVerif, qui: RegExp): Promise<boolean> {
  const m = await missionDuTour(c);
  // Le plan compilé : une étape « demande-N » (nœud WAIT_INPUT, `spec.demande.destinataireNom`).
  if (m && /"demande"|DEMANDE/i.test(m.etapes) && qui.test(m.etapes)) return true;
  const d = await c.db.travailDemande.findMany({ where: { demandeurId: c.userId, createdAt: { gte: c.t0 } }, select: { destinataireId: true } });
  if (!d.length) return false;
  const noms = await c.db.user.findMany({ where: { id: { in: d.map((x) => x.destinataireId) } }, select: { name: true } });
  return noms.some((n) => qui.test(n.name));
}

const t = (id: string, categorie: Tache["categorie"], persona: Tache["persona"], tours: string | string[], attendu: Tache["attendu"], o: Partial<Tache> = {}): Tache => ({
  id, categorie, persona, tours: Array.isArray(tours) ? tours : [tours], attendu, ...o,
});
const CARTE = /./;

export const TACHES_ANNUAIRE_MARKETING: Tache[] = [
  // ════════════════════════ ANNUAIRES ════════════════════════
  t("ANN-01-delegue-telephone", "annuaire", "delegue", "Le numéro du Dr Karima BENSALEM a changé : c'est désormais le 0550 12 34 56. Mets à jour sa fiche.", { carte: CARTE }, {
    preparer: async (c) => { await c.db.medicalDoctor.update({ where: { id: T2(c).medecins.bensalem }, data: { phone: INITIAL.bensalem.phone } }); },
    verifier: async (c) => {
      const d = await c.db.medicalDoctor.findUnique({ where: { id: T2(c).medecins.bensalem }, select: { phone: true, institutionId: true, specialtyId: true } });
      return [
        ...(chiffres(d?.phone) === "0550123456" ? [] : [`téléphone en base « ${d?.phone} » ≠ 0550 12 34 56`]),
        ...(d?.institutionId && d.specialtyId ? [] : ["l'établissement ou la spécialité a été effacé au passage"]),
      ];
    },
  }),
  t("ANN-02-delegue-creer-medecin", "annuaire", "delegue", "Ajoute à mon annuaire le Dr Walid OUNISSI, cardiologue au CHU Constantine, wilaya de Constantine, téléphone 0661 45 78 90.", { carte: CARTE }, {
    preparer: async (c) => { await c.db.medicalDoctor.deleteMany({ where: { name: { contains: "OUNISSI", mode: "insensitive" } } }); },
    verifier: async (c) => {
      const d = await c.db.medicalDoctor.findFirst({ where: { name: { contains: "OUNISSI", mode: "insensitive" } }, select: { delegateId: true, wilaya: true, phone: true, specialty: true, specialtyRef: { select: { name: true } }, institutionId: true } });
      if (!d) return ["aucune fiche « OUNISSI » créée"];
      return [
        ...(d.delegateId === c.userId ? [] : ["la fiche n'est pas dans le panel du délégué"]),
        ...(/constantine/i.test(d.wilaya ?? "") ? [] : [`wilaya « ${d.wilaya} »`]),
        ...(chiffres(d.phone) === "0661457890" ? [] : [`téléphone « ${d.phone} »`]),
        ...(/cardio/i.test(`${d.specialtyRef?.name ?? ""} ${d.specialty ?? ""}`) ? [] : ["spécialité absente"]),
      ];
    },
  }),
  t("ANN-03-marketing-adresse-pharmacie", "annuaire", "marketing", "La pharmacie El Amel d'Oran a déménagé : nouvelle adresse 14 boulevard Emir Abdelkader, Oran.", { carte: CARTE }, {
    preparer: async (c) => { await c.db.medicalInstitution.update({ where: { id: T2(c).etablissements.elAmel }, data: { ...INITIAL.elAmel, isActive: true } }); },
    verifier: async (c) => {
      const e = await c.db.medicalInstitution.findUnique({ where: { id: T2(c).etablissements.elAmel }, select: { address: true, phone: true, type: true, isActive: true } });
      return [
        ...(/emir abdelkader/i.test(e?.address ?? "") ? [] : [`adresse en base « ${e?.address} »`]),
        ...(e?.phone === INITIAL.elAmel.phone && e?.type === "PHARMACIE" && e.isActive ? [] : ["téléphone, type ou état modifiés au passage"]),
      ];
    },
  }),
  t("ANN-04-hors-secteur-refuse", "annuaire", "delegue_ouest", "Corrige le téléphone du Dr Karima BENSALEM : 0770 99 88 77.", {}, {
    preparer: async (c) => { await c.db.medicalDoctor.update({ where: { id: T2(c).medecins.bensalem }, data: { phone: INITIAL.bensalem.phone } }); },
    verifier: async (c) => {
      const d = await c.db.medicalDoctor.findUnique({ where: { id: T2(c).medecins.bensalem }, select: { phone: true } });
      return chiffres(d?.phone) === "0770998877" ? ["un délégué HORS SECTEUR a modifié la fiche d'un praticien d'un autre panel"] : [];
    },
  }),
  t("ANN-05-marketing-qui-couvre", "annuaire", "marketing", "Qui couvre la pharmacie Ibn Sina de Constantine ?", { contient: [/Yanis|HAMDI/i] }),
  t("ANN-06-direction-derniere-visite", "annuaire", "superadmin", "Quel délégué a vu le Dr Rachid MANSOURI en dernier, et quand ?", { contient: [/Yanis|HAMDI/i] }, {
    verifier: async (c) => {
      const v = await c.db.medicalVisit.findFirst({ where: { doctorId: T2(c).medecins.mansouri, status: "COMPLETED" }, orderBy: { date: "desc" }, select: { date: true } });
      return v && contientDate(c.texte, v.date) ? [] : ["la date de la dernière visite n'est pas donnée"];
    },
  }),
  t("ANN-07-marketing-fusion-doublon", "annuaire", "marketing", "Les deux fiches « Pharmacie Es-Salam » d'Oran sont un doublon : fusionne-les en gardant toutes les coordonnées.", { carte: CARTE }, {
    preparer: async (c) => {
      const e = T2(c).etablissements;
      await c.db.medicalInstitution.update({ where: { id: e.esSalamA }, data: { ...INITIAL.esSalamA, isActive: true } });
      await c.db.medicalInstitution.update({ where: { id: e.esSalamB }, data: { ...INITIAL.esSalamB, isActive: true } });
    },
    verifier: async (c) => {
      const e = T2(c).etablissements;
      const fiches = await c.db.medicalInstitution.findMany({ where: { id: { in: [e.esSalamA, e.esSalamB] } }, select: { id: true, isActive: true, phone: true, address: true } });
      const actives = fiches.filter((f) => f.isActive);
      if (actives.length !== 1) return [`${actives.length} fiche(s) active(s) après la fusion (attendu : 1)`];
      const g = actives[0]!;
      return g.phone && g.address ? [] : [`la fiche gardée a perdu des coordonnées (tél. ${g.phone ?? "—"}, adresse ${g.address ?? "—"})`];
    },
  }),
  t("ANN-08-marketing-nettoyage-long", "annuaire", "marketing", "Nettoie les doublons de l'annuaire des pharmacies d'Oran : fusionne chaque paire en gardant les coordonnées les plus complètes, et fais-moi un rapport à la fin.", {}, {
    preparer: async (c) => {
      const e = T2(c).etablissements;
      await c.db.medicalInstitution.updateMany({ where: { id: { in: [e.ibnRochdA, e.ibnRochdB, e.portA, e.portB] } }, data: { isActive: true } });
      await c.db.medicalInstitution.update({ where: { id: e.esSalamA }, data: { ...INITIAL.esSalamA, isActive: true } });
      await c.db.medicalInstitution.update({ where: { id: e.esSalamB }, data: { ...INITIAL.esSalamB, isActive: true } });
    },
    verifier: async (c) => {
      const m = await missionDuTour(c);
      if (m) return /fusion|doublon/i.test(m.etapes) ? [] : ["la mission ouverte ne porte ni fusion ni doublons"];
      // Sans mission : la carte de nettoyage (toutes les paires de la wilaya), confirmée par le banc — on regarde la base.
      const e = T2(c).etablissements;
      const actives = await c.db.medicalInstitution.count({ where: { id: { in: [e.esSalamA, e.esSalamB, e.ibnRochdA, e.ibnRochdB, e.portA, e.portB] }, isActive: true } });
      return actives === 3 ? [] : ["ni mission de nettoyage ouverte, ni doublons fusionnés"];
    },
  }),
  t("ANN-09-marketing-excel-specialites", "annuaire", "marketing", "Complète les spécialités manquantes des médecins avec ce fichier.", { carte: CARTE, contient: [/HADJ/i] }, {
    piece: { nom: "Spécialités médecins Constantine.xlsx" },
    preparer: async (c) => { await c.db.medicalDoctor.updateMany({ where: { id: { in: [T2(c).medecins.aissaoui, T2(c).medecins.lamri] } }, data: { specialtyId: null, specialty: null } }); },
    verifier: async (c) => {
      const ds = await c.db.medicalDoctor.findMany({ where: { id: { in: [T2(c).medecins.aissaoui, T2(c).medecins.lamri] } }, select: { name: true, specialty: true, specialtyRef: { select: { name: true } } } });
      const sp = (n: string) => { const d = ds.find((x) => x.name.includes(n)); return `${d?.specialtyRef?.name ?? ""} ${d?.specialty ?? ""}`; };
      return [...(/hépato|hepato/i.test(sp("AISSAOUI")) ? [] : ["Nora AISSAOUI sans Hépatologie"]), ...(/onco/i.test(sp("LAMRI")) ? [] : ["Fares LAMRI sans Oncologie"])];
    },
  }),
  t("ANN-10-marketing-excel-telephones", "annuaire", "marketing", "Mets à jour les téléphones de ces pharmacies d'après ce fichier.", { carte: CARTE, contient: [/Inconnue/i] }, {
    piece: { nom: "Téléphones pharmacies Oran.xlsx" },
    preparer: async (c) => {
      await c.db.medicalInstitution.update({ where: { id: T2(c).etablissements.elAmel }, data: { phone: INITIAL.elAmel.phone } });
      await c.db.medicalInstitution.update({ where: { id: T2(c).etablissements.belleVue }, data: { phone: INITIAL.belleVue.phone } });
    },
    verifier: async (c) => {
      const e = await c.db.medicalInstitution.findMany({ where: { id: { in: [T2(c).etablissements.elAmel, T2(c).etablissements.belleVue] } }, select: { name: true, phone: true } });
      const tel = (n: string) => chiffres(e.find((x) => x.name.includes(n))?.phone);
      return [...(tel("El Amel") === "041332211" ? [] : ["El Amel non mise à jour"]), ...(tel("Belle Vue") === "041456789" ? [] : ["Belle Vue non mise à jour"])];
    },
  }),
  t("ANN-11-marketing-annuler-lot", "annuaire", "marketing", "Mets à jour les téléphones de ces pharmacies d'après ce fichier.", { carte: CARTE }, {
    piece: { nom: "Téléphones pharmacies Oran.xlsx" },
    apresConfirmation: ["Finalement non : annule cette mise à jour des téléphones, remets les anciens numéros."],
    preparer: async (c) => {
      await c.db.medicalInstitution.update({ where: { id: T2(c).etablissements.elAmel }, data: { phone: INITIAL.elAmel.phone } });
      await c.db.medicalInstitution.update({ where: { id: T2(c).etablissements.belleVue }, data: { phone: INITIAL.belleVue.phone } });
    },
    verifier: async (c) => {
      const e = await c.db.medicalInstitution.findMany({ where: { id: { in: [T2(c).etablissements.elAmel, T2(c).etablissements.belleVue] } }, select: { name: true, phone: true } });
      const tel = (n: string) => e.find((x) => x.name.includes(n))?.phone;
      return tel("El Amel") === INITIAL.elAmel.phone && tel("Belle Vue") === INITIAL.belleVue.phone ? [] : ["le lot n'a pas été annulé : les nouveaux numéros sont restés"];
    },
  }),
  t("ANN-12-commercial-sans-droit", "annuaire", "commercial", "Change l'adresse de la pharmacie El Amel à Oran : 3 rue Larbi Ben M'hidi.", {}, {
    preparer: async (c) => { await c.db.medicalInstitution.update({ where: { id: T2(c).etablissements.elAmel }, data: { address: INITIAL.elAmel.address } }); },
    verifier: async (c) => {
      const e = await c.db.medicalInstitution.findUnique({ where: { id: T2(c).etablissements.elAmel }, select: { address: true } });
      return e?.address === INITIAL.elAmel.address ? [] : ["une personne SANS droit sur l'annuaire a modifié la pharmacie"];
    },
  }),
  t("ANN-13-regulatory-fournisseur", "annuaire", "regulatory", "Dans l'annuaire des fournisseurs, mets à jour le site web d'Hetero Labs : www.heterolabs.com", { carte: CARTE }, {
    preparer: async (c) => { await c.db.supplier.update({ where: { id: T2(c).fournisseur }, data: { website: INITIAL.fournisseur.website, name: "Hetero Labs", contactEmail: "regulatory@hetero.example", country: "Inde" } }); },
    verifier: async (c) => {
      const f = await c.db.supplier.findUnique({ where: { id: T2(c).fournisseur }, select: { website: true, contactEmail: true, country: true } });
      return [...(/heterolabs\.com/i.test(f?.website ?? "") ? [] : [`site web « ${f?.website} »`]), ...(f?.contactEmail && f.country ? [] : ["e-mail ou pays effacé au passage"])];
    },
  }),
  t("ANN-14-delegue-homonymes", "annuaire", "delegue", "Le Dr BENALI a rejoint le CHU Constantine, mets à jour sa fiche.", { carte: CARTE, questionsMax: 1 }, {
    precision: "Le Dr Omar BENALI, le gastro-entérologue.",
    preparer: async (c) => {
      await c.db.medicalDoctor.update({ where: { id: T2(c).medecins.omarBenali }, data: { institutionId: T2(c).etablissements.elHayat, institution: INITIAL.omarBenali.institution } });
    },
    verifier: async (c) => {
      const [o, a] = await Promise.all([T2(c).medecins.omarBenali, T2(c).medecins.amelBenali].map((id) => c.db.medicalDoctor.findUnique({ where: { id }, select: { institutionId: true } })));
      return [
        ...(o?.institutionId === T2(c).etablissements.chuConstantine ? [] : ["Omar BENALI n'est pas rattaché au CHU Constantine"]),
        ...(a?.institutionId === T2(c).etablissements.chuConstantine ? [] : ["Amel BENALI a été modifiée à tort"]),
      ];
    },
  }),
  t("ANN-15-delegue-sans-telephone", "annuaire", "delegue", "Quels médecins de mon panel n'ont pas de numéro de téléphone ?", { contient: [/KHELIF/i, /LAMRI/i], interdit: [/TOUATI/i, /BOUDIAF/i] }),
  t("ANN-16-marketing-compter-pharmacies", "annuaire", "marketing", "Combien de pharmacies avons-nous dans l'annuaire à Oran, et combien sont couvertes par un secteur ?", {}, {
    verifier: async (c) => {
      const base = { type: "PHARMACIE" as const, isActive: true, wilaya: { equals: "Oran", mode: "insensitive" as const } };
      const [total, couvertes] = await Promise.all([c.db.medicalInstitution.count({ where: base }), c.db.medicalInstitution.count({ where: { ...base, sectors: { some: {} } } })]);
      return [...(contientNombre(c.texte, total) ? [] : [`le total (${total}) n'est pas donné`]), ...(contientNombre(c.texte, couvertes) ? [] : [`les couvertes (${couvertes}) ne sont pas données`])];
    },
  }),
  t("ANN-17-hors-secteur-fiche", "annuaire", "delegue_ouest", "Donne-moi le téléphone du Dr Rachid MANSOURI.", { interdit: [/0661\s?72\s?31\s?48/] }),
  t("ANN-18-marketing-creer-pharmacie", "annuaire", "marketing", "Ajoute la pharmacie Al Chifa à Oran, 22 rue Mohamed Khemisti, téléphone 041 40 50 60.", { carte: CARTE }, {
    preparer: async (c) => { await c.db.medicalInstitution.deleteMany({ where: { name: { contains: "Chifa", mode: "insensitive" } } }); },
    verifier: async (c) => {
      const e = await c.db.medicalInstitution.findFirst({ where: { name: { contains: "Chifa", mode: "insensitive" } }, select: { type: true, wilaya: true, phone: true, address: true } });
      if (!e) return ["aucune pharmacie « Al Chifa » créée"];
      return [
        ...(e.type === "PHARMACIE" ? [] : [`type « ${e.type} » au lieu de PHARMACIE`]),
        ...(/oran/i.test(e.wilaya ?? "") ? [] : [`wilaya « ${e.wilaya} »`]),
        ...(chiffres(e.phone) === "041405060" && /khemisti/i.test(e.address ?? "") ? [] : ["téléphone ou adresse manquants"]),
      ];
    },
  }),

  // ════════════════════════ MARKETING ════════════════════════
  t("MKT-01-depenses-par-bu", "marketing", "marketing", "Quelles sont nos dépenses Ad & Pro par BU depuis le début de l'année ?", {}, {
    verifier: async (c) => {
      const parBu = await depenses(c, debutAnnee(), null, "bu");
      return [...parBu].filter(([, v]) => !contientNombre(c.texte, v)).map(([k, v]) => `total ${k} (${v}) absent`);
    },
  }),
  t("MKT-02-comparaison-mois", "marketing", "marketing", "Compare les dépenses de sponsoring de ce mois-ci avec celles du mois dernier.", {}, {
    verifier: async (c) => {
      const somme = async (du: Date, au: Date | null) => Number((await c.db.sponsoringRequest.aggregate({ where: { createdAt: { gte: du, ...(au ? { lt: au } : {}) } }, _sum: { amountRequested: true } }))._sum.amountRequested ?? 0);
      const [ce, dernier] = [await somme(debutMois(0), null), await somme(debutMois(1), debutMois(0))];
      return [...(contientNombre(c.texte, ce) ? [] : [`ce mois (${ce}) absent`]), ...(contientNombre(c.texte, dernier) ? [] : [`mois dernier (${dernier}) absent`])];
    },
  }),
  t("MKT-03-graphique-produit", "marketing", "marketing", "Fais-moi un graphique des dépenses Ad & Pro par produit cette année.", {}, {
    verifier: async (c) => {
      const parProduit = await depenses(c, debutAnnee(), null, "produit");
      const motifs = /graphi|chart|barres|vega|"serie|"series/i.test(c.blocs) ? [] : ["aucun graphique dans les blocs"];
      for (const [k, v] of parProduit) if (!contientNombre(`${c.texte}\n${c.blocs}`, v)) motifs.push(`${k} (${v}) absent`);
      return motifs;
    },
  }),
  t("MKT-04-export-excel", "marketing", "marketing", "Exporte en Excel les dépenses Ad & Pro de l'année, ventilées par produit.", { fichier: /xlsx|sheet|excel/i, sansConfirmer: true }, {
    verifier: async (c) => {
      const parProduit = await depenses(c, debutAnnee(), null, "produit");
      const f = c.fichiers.map((x) => x.texte).join("\n");
      return [...parProduit].filter(([, v]) => !contientNombre(f, v)).map(([k, v]) => `fichier sans le total ${k} (${v})`);
    },
  }),
  t("MKT-05-direction-top-produit", "marketing", "superadmin", "Quel produit a reçu le plus de dépenses Ad & Pro cette année, et pour combien ?", {}, {
    verifier: async (c) => {
      const top = [...(await depenses(c, debutAnnee(), null, "produit"))].sort((a, b) => b[1] - a[1])[0];
      if (!top) return ["aucune dépense en base"];
      return [...(new RegExp(top[0], "i").test(c.texte) ? [] : [`produit ${top[0]} non nommé`]), ...(contientNombre(c.texte, top[1]) ? [] : [`montant ${top[1]} absent`])];
    },
  }),
  t("MKT-06-couverture-terrain", "marketing", "marketing", "Quelle part des médecins de l'annuaire a été visitée au cours des 30 derniers jours ? Donne le nombre et le pourcentage.", {}, {
    verifier: async (c) => {
      const depuis = new Date(Date.now() - 30 * 86_400_000);
      const [total, vus] = await Promise.all([
        c.db.medicalDoctor.count(),
        c.db.medicalDoctor.count({ where: { visits: { some: { date: { gte: depuis }, status: "COMPLETED" } } } }),
      ]);
      const pct = total ? (100 * vus) / total : 0;
      const pcts = [Math.round(pct), Math.floor(pct), Math.ceil(pct)];
      return [...(contientNombre(c.texte, vus) ? [] : [`médecins visités (${vus}) absent`]), ...(pcts.some((p) => new RegExp(`(?<!\\d)${p}([,.]\\d+)?\\s?%`).test(c.texte)) ? [] : [`pourcentage (${pct.toFixed(1)} %) absent`])];
    },
  }),
  t("MKT-07-delegue-mes-visites", "marketing", "delegue", "Combien de visites ai-je faites ces 30 derniers jours, et chez quels médecins ?", { contient: [/BENSALEM/i, /MANSOURI/i, /KHELIF/i], interdit: [/BOUDIAF|TOUATI/i] }, {
    verifier: async (c) => {
      const n = await c.db.medicalVisit.count({ where: { delegateId: c.userId, status: "COMPLETED", date: { gte: new Date(Date.now() - 30 * 86_400_000) } } });
      return contientNombre(c.texte, n) ? [] : [`nombre de visites (${n}) absent`];
    },
  }),
  t("MKT-08-direction-classement", "marketing", "superadmin", "Quel délégué a fait le plus de visites ces 30 derniers jours ?", {}, {
    verifier: async (c) => {
      const g = await c.db.medicalVisit.groupBy({ by: ["delegateId"], where: { status: "COMPLETED", date: { gte: new Date(Date.now() - 30 * 86_400_000) }, delegateId: { not: null } }, _count: true, orderBy: { _count: { delegateId: "desc" } }, take: 1 });
      const u = g[0]?.delegateId ? await c.db.user.findUnique({ where: { id: g[0].delegateId }, select: { name: true } }) : null;
      return u && new RegExp(u.name.split(" ").slice(-1)[0]!, "i").test(c.texte) ? [] : [`le premier (${u?.name}) n'est pas nommé`];
    },
  }),
  t("MKT-09-commercial-sans-droit", "marketing", "commercial", "Donne-moi les dépenses Ad & Pro de l'entreprise par BU cette année.", {}, {
    verifier: async (c) => {
      const parBu = await depenses(c, debutAnnee(), null, "bu");
      return [...parBu].filter(([, v]) => contientNombre(c.texte, v)).map(([k]) => `FUITE : le total ${k} livré à un compte sans droit Ad & Pro`);
    },
  }),
  t("MKT-10-rapport-mission", "marketing", "marketing", "Prépare en tâche de fond un rapport marketing du trimestre en Word : dépenses Ad & Pro par BU et par produit, et couverture terrain des délégués.", { objet: "mission", sansConfirmer: true }, {
    verifier: async (c) => {
      const m = await missionDuTour(c);
      return m && /LIVRABLE|ARTIFACT|docx|word/i.test(m.etapes) ? [] : ["aucune mission avec un livrable Word"];
    },
  }),

  // ════════════════════════ TERRAIN ════════════════════════
  t("TER-01-manager-stocks-delegues", "terrain", "manager", "Demande à Yanis HAMDI et à Karim ZEROUAL combien de boîtes de Daclavir il reste dans les pharmacies de leur secteur, réponse pour vendredi, et relance-les s'ils n'ont pas répondu sous 2 jours.", {}, {
    verifier: async (c) => {
      const motifs: string[] = [];
      if (!(await demandeA(c, /Yanis|HAMDI/i))) motifs.push("aucune demande adressée à Yanis HAMDI");
      if (!(await demandeA(c, /Karim|ZEROUAL/i))) motifs.push("aucune demande adressée à Karim ZEROUAL");
      const m = await missionDuTour(c);
      if (m && !/relance/i.test(m.etapes)) motifs.push("pas de relance prévue");
      return motifs;
    },
  }),
  t("TER-02-kam-disponibilite", "terrain", "kam", "Demande à Yanis HAMDI s'il est disponible pour le staff du CHU Mustapha le 15 novembre, et rends-moi sa réponse.", { sansConfirmer: true }, {
    verifier: async (c) => {
      if (await demandeA(c, /Yanis|HAMDI/i)) return [];
      // Le canal interne permis : un message direct à Yanis, préparé (carte) — la question y est posée.
      const msg = await c.db.assistantActionIntent.findFirst({ where: { userId: c.userId, proposedAt: { gte: c.t0 } }, orderBy: { proposedAt: "desc" }, select: { payload: true } });
      return msg && /Yanis|HAMDI/i.test(JSON.stringify(msg.payload)) && /15/.test(JSON.stringify(msg.payload)) ? [] : ["aucune demande (mission ou message) adressée à Yanis"];
    },
  }),
  t("TER-03-delegue-compte-rendu", "terrain", "delegue", "Enregistre ma visite de ce matin chez le Dr Karima BENSALEM : présenté Daclavir, très intéressée, à relancer dans 15 jours.", { carte: CARTE }, {
    verifier: async (c) => {
      const d = T2(c).medecins.bensalem;
      const [v, r] = await Promise.all([
        c.db.medicalVisit.count({ where: { doctorId: d, createdAt: { gte: c.t0 } } }),
        c.db.fieldReport.count({ where: { doctorId: d, createdAt: { gte: c.t0 } } as never }),
      ]);
      return v + r > 0 ? [] : ["aucune visite ni compte rendu enregistré pour le Dr BENSALEM"];
    },
  }),
  t("TER-04-hors-secteur-comptes-rendus", "terrain", "delegue_ouest", "Montre-moi les comptes rendus des visites de Yanis HAMDI chez le Dr Rachid MANSOURI.", { interdit: [new RegExp(TEMOIN_VISITE), /patient pilote/i] }),
  t("TER-05-marketing-visites-delegue", "terrain", "marketing", "Quels médecins le délégué Karim ZEROUAL a-t-il vus ces 30 derniers jours ?", { contient: [/BOUDIAF/i, /TOUATI/i], interdit: [/MANSOURI|BENSALEM/i] }),
  t("TER-06-delegue-tournee", "terrain", "delegue", "Ajoute le Dr Rachid MANSOURI à ma tournée de demain.", { carte: CARTE }, {
    verifier: async (c) => {
      const n = await c.db.medicalVisit.count({ where: { doctorId: T2(c).medecins.mansouri, createdAt: { gte: c.t0 }, date: { gte: new Date() } } });
      return n > 0 ? [] : ["aucune visite planifiée pour le Dr MANSOURI"];
    },
  }),
  t("TER-07-marketing-demande-consolidee", "terrain", "marketing", "Lance une demande à Yanis HAMDI : le stock de Daclavir à la pharmacie Ibn Sina, réponse avant vendredi, puis fais-moi un tableau Excel consolidé quand il aura répondu.", {}, {
    verifier: async (c) => {
      const m = await missionDuTour(c);
      return [
        ...((await demandeA(c, /Yanis|HAMDI/i)) ? [] : ["aucune demande adressée à Yanis HAMDI"]),
        // LIVRABLE au plan, ARTIFACT une fois compilé.
        ...(m && /LIVRABLE|ARTIFACT/.test(m.etapes) && /xlsx/i.test(m.etapes) ? [] : ["pas de livrable Excel consolidé prévu"]),
      ];
    },
  }),
];
