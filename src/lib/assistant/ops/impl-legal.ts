import { prisma } from "@/lib/prisma";
import { toNumber, montantDzd } from "@/lib/utils";
import {
  renewLegalDocument, cancelLegalDocument, setLegalReaders, sendLegalInvoiceToSettlement, adresserBCAuCentre,
} from "@/lib/actions/legal-actions";
// PAR LE PORT, jamais par `@/lib/actions/*` ni `@/lib/cibles/*` : `boundary.test.ts` a
// compté 430 franchissements pour un plafond de 428 et refusé. Le remède est celui que son
// message nomme — passer par le contrat de plateforme — et c'est exactement la raison
// écrite dans l'en-tête de ce port (§118.72, §118.97, §118.111).
import {
  resoudreCible, rattacherLegalAFiche, detacherLegalDeFiche,
} from "@/platform/in-process/capacites";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { fieldsOf } from "./helpers";
import { resolvePeopleList } from "./impl-drive";
import { addAdProComment, legalReaderWhere } from "@/platform/in-process/capacites";

/**
 * OPS LEGAL — renouveler (chaîne de documents), annuler, régler les LECTEURS (le déposant
 * choisit, nul autre ne voit), envoyer une facture au règlement — par les ACTIONS CANONIQUES
 * de `legal-actions.ts` (droits du déposant et cloisonnement re-vérifiés à l'exécution).
 */

interface LegalHit { id: string; title: string; reference: string | null; kind: string; status: string; amount: number | null; endDate: Date | null }

const day = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "sans échéance");

/**
 * RÉSOUDRE UN DOCUMENT LÉGAL PAR SON NOM — dans ce que la personne a le droit de LIRE.
 *
 * Le résolveur cherchait dans TOUT le registre. Or un document peut être RESTREINT à des lecteurs
 * désignés (§ lecteurs), et la carte de confirmation affiche son titre — la liste d'ambiguïté en
 * affiche même plusieurs. Quiconque tenait l'écriture sur Legal pouvait donc apprendre, par la
 * conversation, le titre d'un contrat confidentiel qu'il ne peut pas ouvrir à l'écran : une porte
 * ouverte à côté de la porte gardée (§118.71). L'action, elle, revérifie au clic — mais le titre
 * a déjà été dit. La restriction se compose donc ICI, par la même règle que la fiche
 * (`legalReaderWhere`, au socle), et un document hors portée n'apparaît même pas comme candidat.
 */
async function resolveLegalDoc(
  raw: string, user: { id: string; role: string }, extra?: { kind?: string },
): Promise<LegalHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez le titre ou la référence du document légal (champ « reference »)." };
  const lecteurs = legalReaderWhere({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" });
  const rows = await prisma.legalDocument.findMany({
    where: {
      ...(extra?.kind ? { kind: extra.kind as never } : {}),
      AND: [
        { OR: [{ reference: { equals: q, mode: "insensitive" } }, { title: { contains: q, mode: "insensitive" } }] },
        ...(lecteurs ? [lecteurs] : []),
      ],
    },
    select: { id: true, title: true, reference: true, kind: true, status: true, amount: true, endDate: true },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  const hits: LegalHit[] = rows.map((r) => ({ ...r, amount: r.amount === null ? null : toNumber(r.amount) }));
  if (hits.length === 0) return { error: `Aucun document légal « ${q} »${extra?.kind === "INVOICE" ? " (facture)" : ""}.` };
  const exact = hits.filter((h) => (h.reference ?? "").toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (hits.length === 1) return hits[0];
  return { error: `Plusieurs documents correspondent à « ${q} » : ${hits.map((h) => `${h.reference ? `${h.reference} — ` : ""}${h.title}`).join(" ; ")} — préciser.` };
}

const iso = (raw: string): string | null => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

const LEGAL_REVALIDATE = ["/legal"];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FICHE SUR LAQUELLE BRANCHER UNE PIÈCE — six natures, UN résolveur.
 *
 * L'écran offre ce geste depuis la demande (on coche un document dans une liste déjà filtrée
 * par les droits) ; en conversation, la personne NOMME la fiche : « rattache la convention
 * Sanofi à SP-2026-014 ». Il faut donc traduire un texte en ligne de base, et c'est
 * exactement ce que `resoudreCible` fait pour les 29 objets du registre — on n'écrit pas un
 * 118ᵉ résolveur à la main (§118.85).
 *
 * ── POURQUOI LA NATURE EST FACULTATIVE, ET CE QUE ÇA COÛTE ──────────────────────────────
 *
 * `resoudreCible` répond pour UNE entité ; une demande Ad & Pro peut être l'une de six. Sans
 * nature donnée, on interroge les six et on n'accepte qu'UNE seule correspondance sur
 * l'ensemble : plusieurs natures qui répondent ne désignent AUCUNE fiche, et en choisir une
 * rattacherait la pièce au mauvais dossier en annonçant que c'est fait (§104.7). Six requêtes
 * bornées à la portée de la personne coûtent moins qu'un aller-retour de plus (§118.30), et
 * la portée est celle de l'ÉCRAN — `resoudreCible` compose `porteeEntite`, donc une fiche hors
 * périmètre n'apparaît même pas comme candidate. L'ACTEUR arrive par la signature de `propose` :
 * rouvrir la session ici donnerait un second chemin vers l'identité, et c'est celui qui prendrait
 * du retard le jour où le runtime agit pour quelqu'un d'autre (§118.5, §118.7).
 *
 * `promo_material` n'est PAS de la liste : il n'a pas d'entrée au registre d'entités, donc
 * aucune portée de lecture déclarée. L'ajouter ici en devinant sa clause reviendrait à écrire
 * une décision de permission dans un résolveur (§118.86) ; le geste reste offert à l'écran, et
 * le refus le DIT au lieu de laisser croire que la pièce n'existe pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const NATURES_RATTACHABLES: { entite: string; entityType: string; libelle: string }[] = [
  { entite: "sponsoring", entityType: "SPONSORING", libelle: "sponsoring" },
  { entite: "congress_international", entityType: "CONGRESS_INTERNATIONAL", libelle: "congrès international" },
  { entite: "congress_national", entityType: "CONGRESS_NATIONAL", libelle: "prise en charge nationale" },
  { entite: "event", entityType: "EVENT", libelle: "événement" },
  { entite: "ad_pro_other", entityType: "AD_PRO_OTHER", libelle: "demande Ad & Pro « autre »" },
  { entite: "consulting_contract", entityType: "CONSULTING_CONTRACT", libelle: "contrat de consulting" },
];

interface FicheHit { entityType: string; entityId: string; label: string; libelle: string }

type ActeurOp = Parameters<OpImpl["propose"]>[1];

async function resolveFicheAdPro(
  user: ActeurOp,
  raw: string,
  nature: string,
): Promise<FicheHit | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez la fiche à laquelle rattacher le document (champ « target » : sa référence ou son intitulé)." };

  const n = nature.trim().toLowerCase();
  const cherchees = n
    ? NATURES_RATTACHABLES.filter((x) => x.entite === n || x.entityType.toLowerCase() === n || x.libelle.startsWith(n))
    : NATURES_RATTACHABLES;
  if (cherchees.length === 0) {
    return {
      error: `Nature « ${nature} » inconnue. Natures rattachables : ${NATURES_RATTACHABLES.map((x) => x.libelle).join(", ")}. `
        + "Le matériel promotionnel se rattache depuis son écran.",
    };
  }

  const trouves: FicheHit[] = [];
  const candidats: string[] = [];
  for (const x of cherchees) {
    // Pas de garde « l'entité est-elle au registre ? » : `resoudreCible` rend déjà une
    // résolution VIDE sur une entité inconnue. La répéter ici ne protégerait de rien et ferait
    // traverser la frontière Adam ↔ ERP pour un fait que l'appelé connaît (§118.5).
    const r = await resoudreCible(user, x.entite, q);
    // `titre` porte la référence quand l'objet en a une, `sousTitre` ce qui distingue deux
    // homonymes : les deux, sinon « SP-2026-014 » et « SP-2026-015 » seraient indiscernables
    // dans une liste de candidats, et le refus n'aiderait personne à choisir.
    const nommer = (c: { titre: string; sousTitre: string | null }): string =>
      c.sousTitre ? `${c.titre} — ${c.sousTitre}` : c.titre;
    for (const c of r.retenu) trouves.push({ entityType: x.entityType, entityId: c.id, label: nommer(c), libelle: x.libelle });
    for (const c of r.candidats) candidats.push(`${nommer(c)} (${x.libelle})`);
  }

  if (trouves.length === 1) return trouves[0];
  if (trouves.length > 1) {
    return {
      error: `« ${q} » désigne ${trouves.length} fiches : ${trouves.map((t) => `${t.label} (${t.libelle})`).join(" ; ")} `
        + "— précisez la nature (champ « nature ») ou la référence exacte.",
    };
  }
  if (candidats.length > 0) {
    return { error: `Plusieurs fiches correspondent à « ${q} » : ${candidats.slice(0, 8).join(" ; ")} — précisez.` };
  }
  return { error: `Aucune fiche « ${q} » dans votre périmètre (natures cherchées : ${cherchees.map((x) => x.libelle).join(", ")}).` };
}

export const LEGAL_OPS_IMPL: Record<string, OpImpl> = {
  link_record: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const doc = await resolveLegalDoc(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in doc) return doc;
      const fiche = await resolveFicheAdPro(user, opStr(input, "target") || opStr(input, "name"), opStr(input, "nature") || opStr(input, "kind"));
      if ("error" in fiche) return fiche;
      return {
        title: `Rattacher « ${doc.title} » à ${fiche.label}`,
        fields: fieldsOf([
          ["Document", `${doc.reference ? `${doc.reference} — ` : ""}${doc.title}`],
          ["Montant", doc.amount === null ? "—" : montantDzd(doc.amount)],
          ["Fiche", `${fiche.label} (${fiche.libelle})`],
        ]),
        warnings: [
          "SANS COPIE ET SANS DOUBLON : la pièce existante est BRANCHÉE sur la fiche — aucun second engagement n'est créé.",
          "Un document déjà rattaché à une AUTRE fiche est refusé et la fiche qui le porte est nommée : détachez-le d'abord.",
        ],
        args: { legalId: doc.id, entityType: fiche.entityType, entityId: fiche.entityId },
        successMessage: `« ${doc.title} » est rattaché·e à ${fiche.label}.`,
        link: "/legal", revalidate: ["/legal"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("legalId", args.legalId ?? "");
      fd.set("entityType", args.entityType ?? "");
      fd.set("entityId", args.entityId ?? "");
      const r = await rattacherLegalAFiche(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le rattachement a été refusé." };
      return { ok: true, link: "/legal", revalidate: LEGAL_REVALIDATE };
    },
  },

  /**
   * LA DISCUSSION D'UNE DEMANDE Ad & Pro — le MÊME fil que l'écran, par la MÊME porte.
   *
   * Elle vit sur l'outil Legal parce que `resolveFicheAdPro` y est déjà : c'est le seul
   * résolveur du dépôt qui sait désigner l'une des SEPT natures du pôle depuis une référence ou
   * un intitulé. En écrire un second pour l'occasion en ferait deux qui choisissent
   * différemment, et le symptôme serait un message posé sur la mauvaise demande (§104.7).
   */
  comment_ad_pro: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const fiche = await resolveFicheAdPro(user, opStr(input, "target") || opStr(input, "name"), opStr(input, "nature") || opStr(input, "kind"));
      if ("error" in fiche) return fiche;
      const body = opStr(input, "message") || opStr(input, "note") || opStr(input, "body");
      if (!body) return { error: "Écrivez le message à poser sur le fil (champ « message »)." };
      return {
        title: `Écrire dans la discussion de ${fiche.label}`,
        fields: fieldsOf([["Demande", `${fiche.label} (${fiche.libelle})`], ["Message", body]]),
        warnings: [
          "Le fil est LU par tous les acteurs de la demande — demandeur, Direction Marketing, Direction.",
        ],
        args: { entityType: fiche.entityType, entityId: fiche.entityId, body },
        successMessage: `Message posé sur le fil de ${fiche.label}.`,
        revalidate: [],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("entityType", args.entityType ?? "");
      fd.set("entityId", args.entityId ?? "");
      fd.set("body", args.body ?? "");
      const r = await addAdProComment(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le message a été refusé." };
      return { ok: true, revalidate: [] };
    },
  },

  unlink_record: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const doc = await resolveLegalDoc(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in doc) return doc;
      // On LIT le rattachement courant : une carte qui ne dit pas DE QUOI on détache ferait
      // valider à l'aveugle, et l'objet de la confirmation est justement ce lien (§118.83).
      const lien = await prisma.legalDocument.findUnique({
        where: { id: doc.id },
        select: { sourceType: true, sourceId: true },
      });
      if (!lien?.sourceType || !lien.sourceId) {
        return { error: `« ${doc.title} » n'est rattaché·e à aucune fiche — il n'y a rien à détacher.` };
      }
      const nature = NATURES_RATTACHABLES.find((x) => x.entityType === lien.sourceType);
      return {
        title: `Détacher « ${doc.title} »`,
        fields: fieldsOf([
          ["Document", `${doc.reference ? `${doc.reference} — ` : ""}${doc.title}`],
          ["Rattaché·e à", `${nature ? nature.libelle : lien.sourceType} ${lien.sourceId}`],
        ]),
        warnings: ["La pièce n'est ni supprimée ni modifiée : elle cesse d'apparaître sur la fiche et redevient rattachable ailleurs."],
        args: { legalId: doc.id },
        successMessage: `« ${doc.title} » est détaché·e.`,
        link: "/legal", revalidate: ["/legal"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("legalId", args.legalId ?? "");
      const r = await detacherLegalDeFiche(undefined, fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le détachement a été refusé." };
      return { ok: true, link: "/legal", revalidate: LEGAL_REVALIDATE };
    },
  },

  renew: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const doc = await resolveLegalDoc(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in doc) return doc;
      const startDate = iso(opStr(input, "startDate"));
      const endDate = iso(opStr(input, "endDate"));
      return {
        title: `Renouveler « ${doc.title} »`,
        fields: [
          { label: "Document", value: `${doc.reference ? `${doc.reference} — ` : ""}${doc.title}` },
          { label: "Échéance actuelle", value: day(doc.endDate) },
          { label: "Nouvelle période", value: `${startDate ?? "reprend la précédente"} → ${endDate ?? "reprend la précédente"}` },
        ],
        warnings: ["Un document SUIVANT est créé dans la chaîne — l'ancien est marqué renouvelé, l'historique reste lisible."],
        args: { id: doc.id, startDate, endDate, notes: opStr(input, "notes"), label: doc.title },
        successMessage: `« ${doc.title} » renouvelé — le document suivant de la chaîne est créé.`,
        link: "/legal",
        revalidate: LEGAL_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      if (args.startDate) fd.set("startDate", args.startDate);
      if (args.endDate) fd.set("endDate", args.endDate);
      if (args.notes) fd.set("notes", args.notes);
      const r = await renewLegalDocument(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le renouvellement a été refusé." };
      return { ok: true, createdId: r.id, link: "/legal", revalidate: LEGAL_REVALIDATE };
    },
  },

  cancel: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const doc = await resolveLegalDoc(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in doc) return doc;
      const reason = opStr(input, "note");
      return {
        title: `Annuler le document légal « ${doc.title} »`,
        fields: [
          { label: "Document", value: `${doc.reference ? `${doc.reference} — ` : ""}${doc.title}` },
          { label: "Motif", value: reason || "(aucun)" },
        ],
        warnings: ["Le document sort des rappels d'échéance — rien n'est effacé, le motif est conservé."],
        args: { id: doc.id, reason, label: doc.title },
        successMessage: `Document « ${doc.title} » annulé.`,
        link: "/legal",
        revalidate: LEGAL_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      if (args.reason) fd.set("reason", args.reason);
      const r = await cancelLegalDocument(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'annulation a été refusée." };
      return { ok: true, revalidate: LEGAL_REVALIDATE };
    },
  },

  set_readers: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const doc = await resolveLegalDoc(opStr(input, "reference") || opStr(input, "label"), user);
      if ("error" in doc) return doc;
      const rawPeople = opStr(input, "people");
      if (!rawPeople) return { error: "Donnez les lecteurs (champ « people », noms séparés par des virgules) — liste vide impossible par ici." };
      const { people, problems } = await resolvePeopleList(rawPeople, "");
      if (people.length === 0) return { error: `Aucune personne résolue : ${problems.join(" ; ")}.` };
      return {
        title: `Lecteurs de « ${doc.title} » : ${people.map((p) => p.name).join(", ")}`,
        fields: [
          { label: "Document", value: `${doc.reference ? `${doc.reference} — ` : ""}${doc.title}` },
          { label: "Lecteurs", value: people.map((p) => p.name).join(", ") },
        ],
        warnings: [
          "La liste des lecteurs est REMPLACÉE par celle-ci — le déposant garde toujours l'accès, nul autre ne voit.",
          ...problems.map((p) => `Ignoré : ${p}.`),
        ],
        args: { id: doc.id, userIds: people.map((p) => p.id).join(","), label: doc.title },
        successMessage: `Lecteurs de « ${doc.title} » mis à jour (${people.length} personne(s)).`,
        link: "/legal",
        revalidate: LEGAL_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      for (const id of (args.userIds ?? "").split(",").filter(Boolean)) fd.append("readerId", id);
      const r = await setLegalReaders(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "La mise à jour des lecteurs a été refusée." };
      return { ok: true, revalidate: LEGAL_REVALIDATE };
    },
  },

  send_invoice_settlement: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const doc = await resolveLegalDoc(opStr(input, "reference") || opStr(input, "label"), user, { kind: "INVOICE" });
      if ("error" in doc) return doc;
      if (doc.amount === null || doc.amount <= 0) {
        return { error: `La facture « ${doc.title} » n'a pas de montant renseigné — le renseigner sur la fiche avant l'envoi au règlement.` };
      }
      return {
        title: `Envoyer la facture « ${doc.title} » au règlement (${montantDzd(doc.amount)})`,
        fields: [
          { label: "Facture", value: `${doc.reference ? `${doc.reference} — ` : ""}${doc.title}` },
          { label: "Montant", value: montantDzd(doc.amount) },
        ],
        warnings: ["Un ORDRE DE DÉPENSE est créé dans le circuit Finances / Centre de paiement — rien n'est décaissé ici. Une facture déjà partie au règlement est refusée."],
        args: { id: doc.id, label: doc.title },
        successMessage: `Facture « ${doc.title} » envoyée au règlement — ordre de dépense créé.`,
        link: "/legal",
        revalidate: [...LEGAL_REVALIDATE, "/finances"],
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await sendLegalInvoiceToSettlement(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'envoi au règlement a été refusé." };
      return { ok: true, revalidate: [...LEGAL_REVALIDATE, "/finances"] };
    },
  },

  /**
   * ADRESSER UN BC À SON CENTRE (§118.148). La carte ne dit PAS lequel des deux centres : c'est
   * l'origine du BC qui le décide, lue par l'action au moment du clic. Le deviner ici demanderait
   * de relire la chaîne d'origine côté Adam — une seconde lecture de la même règle, qui finirait
   * par désigner un autre centre que l'action (§118.5). La phrase de retour, elle, le nomme.
   */
  submit_purchase_order: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const doc = await resolveLegalDoc(opStr(input, "reference") || opStr(input, "label"), user, { kind: "PURCHASE_ORDER" });
      if ("error" in doc) return doc;
      if (doc.status === "CANCELLED") {
        return { error: `Le bon de commande « ${doc.title} » est annulé : il n'a plus rien à faire valider.` };
      }
      return {
        title: `Adresser le bon de commande « ${doc.title} » à son centre de validation`,
        fields: [
          { label: "Bon de commande", value: `${doc.reference ? `${doc.reference} — ` : ""}${doc.title}` },
          { label: "Montant", value: doc.amount != null && doc.amount > 0 ? montantDzd(doc.amount) : "non renseigné" },
        ],
        warnings: [
          "Le centre dépend de l'ORIGINE du bon de commande : centre de validation Ad & Pro s'il vient d'une demande Ad & Pro, centre de validations sinon.",
          "Un bon de commande déjà au centre n'est pas renvoyé — rien n'est validé ici, c'est le centre qui décide.",
        ],
        args: { id: doc.id, label: doc.title },
        successMessage: `Bon de commande « ${doc.title} » adressé à son centre de validation.`,
        link: `/legal/${doc.id}`,
        revalidate: LEGAL_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      const r = await adresserBCAuCentre(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'envoi au centre a été refusé." };
      return { ok: true, message: r.message, link: `/legal/${args.id}`, revalidate: LEGAL_REVALIDATE };
    },
  },
};
