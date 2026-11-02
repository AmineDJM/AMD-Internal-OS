/**
 * OPS VAGUE 4a — STOCKS : lieux (hôpitaux / annexes) et états datés, dans la portée de stock de
 * celui qui parle. Par les actions canoniques.
 */
import { prisma } from "./erp";
import { createStockHospital, deleteStockHospital, createStockAnnex, deleteStockAnnex, recordStockSnapshot, deleteStockSnapshot } from "@/lib/actions/stock-snapshot-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, resolveOne, isoDate } from "../../helpers";
import { fold } from "../../impl-regulatory";
import { chargerPorteeStock, chercherEtablissementDeStock, chercherLieuHerite, estRestreinte } from "@/platform/in-process/stocks";
import { day } from "./commun";

// ─────────────────────────── STOCKS (lieux + états) ───────────────────────────

const resolveStockLocation = (raw: string, kind: "HOSPITAL" | "ANNEX") =>
  resolveOne(raw, kind === "HOSPITAL" ? "l'hôpital (champ « location »)" : "l'annexe PCH (champ « location »)",
    (q) => prisma.stockAnnex.findMany({ where: { name: { contains: q, mode: "insensitive" }, kind }, select: { id: true, name: true }, take: 6 }),
    (l) => l.name);

const resolveStockProduct = (raw: string) =>
  resolveOne(raw, "le produit (champ « product » — DCI ou nom commercial)",
    (q) => prisma.regulatoryProduct.findMany({
      where: { OR: [{ dci: { contains: q, mode: "insensitive" } }, { brandName: { contains: q, mode: "insensitive" } }] },
      select: { id: true, dci: true, brandName: true }, orderBy: { updatedAt: "desc" }, take: 6,
    }),
    (p) => p.brandName ?? p.dci);

function stockScope(raw: string): { scope: "PCH" | "HOSPITAL" | "ANNEX"; label: string } | { error: string } {
  const q = fold(raw);
  if (!q || /^pch$|centrale/.test(q)) return { scope: "PCH", label: "PCH (centrale)" };
  if (/hopital|hospit/.test(q)) return { scope: "HOSPITAL", label: "Hôpital" };
  if (/annexe/.test(q)) return { scope: "ANNEX", label: "Annexe PCH" };
  return { error: `Lieu « ${raw} » inconnu — valeurs : PCH, hôpital, annexe (champ « kind »).` };
}

/**
 * UN HÔPITAL DE STOCK EST UN ÉTABLISSEMENT DE L'ANNUAIRE (§118.134) — exact → unique → ambiguïté
 * LISTÉE avec la wilaya, parce que deux établissements peuvent porter le même nom et qu'une liste
 * qui répète deux fois le même mot ne lève rien (§104.7). Rend `null` quand rien ne correspond :
 * l'appelant dit alors le remède qui vaut pour LUI (créer l'établissement, ou un lieu hérité).
 */
async function resoudreEtablissement(
  raw: string,
  portee: Awaited<ReturnType<typeof chargerPorteeStock>>,
): Promise<{ id: string; name: string; label: string } | null | { error: string }> {
  const q = raw.trim();
  if (!q) return { error: "Précisez l'hôpital (champ « location »)." };
  const rows = await chercherEtablissementDeStock(q, portee);
  if (rows.length === 0) return null;
  const exact = rows.filter((r) => fold(r.name) === fold(q));
  if (exact.length === 1) return exact[0];
  if (rows.length === 1) return rows[0];
  return { error: `Plusieurs établissements correspondent à « ${q} » : ${rows.map((r) => r.label).join(", ")} — préciser (la wilaya suffit).` };
}

function locationOps(kind: "HOSPITAL" | "ANNEX"): Record<string, OpImpl> {
  const noun = kind === "HOSPITAL" ? "l'hôpital" : "l'annexe PCH";
  const Noun = kind === "HOSPITAL" ? "Hôpital" : "Annexe PCH";
  const remove = kind === "HOSPITAL" ? deleteStockHospital : deleteStockAnnex;
  const createOp: OpImpl = kind === "HOSPITAL"
    ? {
        // AJOUTER UN HÔPITAL AUX STOCKS = le désigner dans l'annuaire des établissements. Un nom
        // absent de l'annuaire n'est pas créé « à côté » : le refus nomme le geste.
        async propose(input, user): Promise<OpProposalDraft | { error: string }> {
          const name = opStr(input, "location") || opStr(input, "name");
          if (!name) return { error: "Précisez l'établissement de l'annuaire à ajouter aux stocks (champ « location »)." };
          const portee = await chargerPorteeStock(user);
          const hit = await resoudreEtablissement(name, portee);
          if (hit && "error" in hit) return hit;
          if (!hit) {
            return { error: `« ${name} » n'est pas dans l'annuaire des établissements. Les hôpitaux du module Stocks sont ceux de l'annuaire : créez-le d'abord (medical_operation / create_institution, ou Annuaires › Établissements), puis ajoutez-le aux stocks.` };
          }
          return {
            title: `Ajouter « ${hit.name} » aux lieux de stock`,
            fields: [{ label: "Établissement (annuaire)", value: hit.label }],
            warnings: ["Réservé au Super Admin — l'hôpital devient disponible pour les états de stock, et les KAM dont le secteur le contient le voient."],
            args: { institutionId: hit.id, name: hit.name },
            successMessage: `« ${hit.name} » ajouté aux lieux de stock.`,
            revalidate: ["/stocks"],
          };
        },
        execute: (args) => runFd(createStockHospital, args, "L'ajout de l'hôpital a été refusé.", { revalidate: ["/stocks"] }),
      }
    : {
        async propose(input): Promise<OpProposalDraft | { error: string }> {
          const name = opStr(input, "location") || opStr(input, "name");
          if (!name) return { error: `Précisez le nom de ${noun} (champ « location »).` };
          return {
            title: `Créer ${noun} « ${name} »`,
            fields: [{ label: Noun, value: name }],
            warnings: ["Création réservée au Super Admin — le lieu devient disponible pour les états de stock."],
            args: { name },
            successMessage: `${Noun} « ${name} » créé.`,
            revalidate: ["/stocks"],
          };
        },
        execute: (args) => runFd(createStockAnnex, args, "La création du lieu a été refusée.", { revalidate: ["/stocks"] }),
      };
  return {
    [kind === "HOSPITAL" ? "create_hospital" : "create_annex"]: createOp,
    [kind === "HOSPITAL" ? "delete_hospital" : "delete_annex"]: {
      async propose(input): Promise<OpProposalDraft | { error: string }> {
        const loc = await resolveStockLocation(opStr(input, "location") || opStr(input, "name"), kind);
        if ("error" in loc) return loc;
        const snaps = await prisma.stockSnapshot.count({ where: { annexId: loc.id } });
        return {
          title: `SUPPRIMER ${noun} « ${loc.name} »`,
          fields: [{ label: Noun, value: loc.name }, { label: "États de stock enregistrés", value: String(snaps) }],
          warnings: [`Suppression définitive : ${noun} ET ses ${snaps} état(s) de stock disparaissent (Super Admin).`],
          confirmText: loc.name,
          args: { id: loc.id },
          successMessage: `${Noun} « ${loc.name} » supprimé (états compris).`,
          revalidate: ["/stocks"],
        };
      },
      execute: (args) => runFd(remove, args, "La suppression du lieu a été refusée.", { revalidate: ["/stocks"] }),
    },
  };
}

export const STOCK4_OPS_IMPL: Record<string, OpImpl> = {
  ...locationOps("HOSPITAL"),
  ...locationOps("ANNEX"),

  record_snapshot: {
    async propose(input, user): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveStockProduct(opStr(input, "product") || opStr(input, "name"));
      if ("error" in product) return product;
      const scope = stockScope(opStr(input, "kind"));
      if ("error" in scope) return scope;
      let annexId: string | null = null; let institutionId: string | null = null; let locationName = scope.label;
      if (scope.scope === "HOSPITAL") {
        // L'HÔPITAL EST UN ÉTABLISSEMENT DE L'ANNUAIRE, cherché dans la PORTÉE de la personne :
        // proposer un hôpital hors de son secteur ferait une carte que l'action refuse (§118.83).
        // La vue globale peut encore relever un lieu HÉRITÉ (sans établissement), et lui seul.
        const portee = await chargerPorteeStock(user);
        const raw = opStr(input, "location");
        const etab = await resoudreEtablissement(raw, portee);
        if (etab && "error" in etab) return etab;
        if (etab) { institutionId = etab.id; locationName = `${scope.label} — ${etab.label}`; }
        else {
          const herites = estRestreinte(portee) ? [] : await chercherLieuHerite(raw.trim());
          if (herites.length === 1) { annexId = herites[0].id; locationName = `${scope.label} — ${herites[0].label} (lieu hérité, hors annuaire)`; }
          else if (herites.length > 1) return { error: `Plusieurs lieux hérités correspondent à « ${raw} » : ${herites.map((h) => h.label).join(", ")} — préciser.` };
          else if (!raw.trim()) return { error: "Précisez l'hôpital (champ « location »)." };
          else if (estRestreinte(portee)) {
            return { error: `« ${raw} » n'est pas un établissement de ${portee.mode === "BU" ? "votre BU" : "votre secteur"}${portee.secteurs.length ? ` (${portee.secteurs.map((x) => x.nom).join(", ")})` : ""} : vous ne relevez que les hôpitaux de votre périmètre.` };
          } else return { error: `Aucun établissement « ${raw} » dans l'annuaire des établissements, ni lieu de stock hérité de ce nom.` };
        }
      } else if (scope.scope === "ANNEX") {
        const loc = await resolveStockLocation(opStr(input, "location"), "ANNEX");
        if ("error" in loc) return loc;
        annexId = loc.id; locationName = `${scope.label} — ${loc.name}`;
      }
      const date = isoDate(opStr(input, "date"));
      if (!date) return { error: "Indiquez la date de l'état (champ « date », AAAA-MM-JJ)." };
      const qty = opStr(input, "quantity");
      if (!qty || Number(qty) < 0 || !Number.isFinite(Number(qty))) return { error: "Indiquez la quantité restante (champ « quantity », ≥ 0)." };
      return {
        title: `État de stock — ${product.brandName ?? product.dci} : ${qty} u.`,
        fields: [
          { label: "Produit", value: product.brandName ?? product.dci },
          { label: "Lieu", value: locationName },
          { label: "Date", value: date },
          { label: "Quantité restante", value: `${qty} unité(s)` },
        ],
        warnings: ["Un état existant du MÊME JOUR (produit + lieu) est remplacé — c'est la correction normale."],
        args: { scope: scope.scope, annexId, institutionId, productId: product.id, date, quantity: qty },
        successMessage: `État de stock enregistré — ${product.brandName ?? product.dci} : ${qty} u. (${locationName}).`,
        link: "/stocks", revalidate: ["/stocks"],
      };
    },
    execute: (args) => runFd(recordStockSnapshot, args, "L'état de stock a été refusé.", { revalidate: ["/stocks"] }),
  },

  delete_snapshot: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const product = await resolveStockProduct(opStr(input, "product") || opStr(input, "name"));
      if ("error" in product) return product;
      const date = isoDate(opStr(input, "date"));
      const rows = await prisma.stockSnapshot.findMany({
        where: {
          productId: product.id,
          ...(date ? { date: { gte: new Date(`${date}T00:00:00Z`), lt: new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000) } } : {}),
        },
        select: { id: true, scope: true, date: true, quantity: true, annex: { select: { name: true } } },
        orderBy: { date: "desc" }, take: 6,
      });
      const label = (s: (typeof rows)[number]) => `${day(s.date)} · ${s.annex?.name ?? s.scope} · ${s.quantity} u.`;
      if (rows.length === 0) return { error: `Aucun état de stock pour ${product.brandName ?? product.dci}${date ? ` le ${date}` : ""}.` };
      if (rows.length > 1) return { error: `Plusieurs états correspondent : ${rows.map(label).join(" ; ")} — préciser la date (champ « date »).` };
      return {
        title: `Supprimer l'état de stock du ${day(rows[0].date)} (${product.brandName ?? product.dci})`,
        fields: [{ label: "État", value: label(rows[0]) }],
        warnings: ["Suppression de la mesure datée (correction) — le produit et le lieu restent."],
        args: { id: rows[0].id },
        successMessage: "État de stock supprimé.",
        revalidate: ["/stocks"],
      };
    },
    execute: (args) => runFd(deleteStockSnapshot, args, "La suppression de l'état a été refusée.", { revalidate: ["/stocks"] }),
  },
};
