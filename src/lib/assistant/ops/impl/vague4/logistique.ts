/**
 * OPS VAGUE 4a — LOGISTIQUE : commandes d'acheminement et leurs jalons. Par les actions canoniques.
 */
import { prisma } from "./erp";
import { createLogistics, updateLogisticsStatus } from "@/lib/actions/logistics-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, fieldsOf, resolveOne, isoDate } from "../../helpers";
import { statusIn } from "./commun";

// ─────────────────────────── LOGISTIQUE ───────────────────────────

const LOGISTICS_STATUS_FR: [string, string][] = [
  ["ORDERED", "Commandé"], ["PRODUCTION", "En production"], ["SHIPPED", "Expédié"],
  ["ARRIVED_TERMINAL", "Arrivé au terminal (port / aéroport)"], ["CUSTOMS", "En dédouanement"],
  ["DELIVERED", "Livré"], ["BLOCKED", "Bloqué"],
];

const resolveShipment = (raw: string) =>
  resolveOne(raw, "la commande logistique (champ « reference » — CMD-AAAA-NNN ou produit)",
    (q) => prisma.logisticsOrder.findMany({
      where: { OR: [{ reference: { contains: q, mode: "insensitive" } }, { product: { contains: q, mode: "insensitive" } }] },
      select: { id: true, reference: true, product: true, status: true }, orderBy: { createdAt: "desc" }, take: 6,
    }),
    (o) => `${o.reference} — ${o.product}`);

export const LOGISTICS_OPS_IMPL: Record<string, OpImpl> = {
  create_shipment: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const product = opStr(input, "product") || opStr(input, "name");
      if (!product) return { error: "Précisez le produit commandé (champ « product »)." };
      const status = statusIn(opStr(input, "status"), LOGISTICS_STATUS_FR);
      if (status && typeof status === "object") return status;
      const amount = opStr(input, "amount");
      return {
        title: `Commande logistique — ${product}`,
        fields: fieldsOf([
          ["Produit", product], ["DCI", opStr(input, "dci") || null],
          ["Fournisseur", opStr(input, "supplier") || null], ["Pays", opStr(input, "country") || null],
          ["Quantité commandée", opStr(input, "quantity") || null],
          ["Valeur", amount ? `${Number(amount).toLocaleString("fr-FR")} ${opStr(input, "currency") || "EUR"}` : null],
          ["Commandé le", isoDate(opStr(input, "date"))],
          ["Transporteur", opStr(input, "carrier") || null], ["Incoterm", opStr(input, "incoterm") || null],
        ]),
        warnings: ["La référence CMD-AAAA-NNN est numérotée automatiquement."],
        args: {
          product, dci: opStr(input, "dci") || null, dosage: opStr(input, "dosage") || null,
          supplier: opStr(input, "supplier") || null, country: opStr(input, "country") || null,
          quantityOrdered: opStr(input, "quantity") || null, orderDate: isoDate(opStr(input, "date")),
          estimatedDeparture: isoDate(opStr(input, "departureDate")), estimatedArrival: isoDate(opStr(input, "arrivalDate")),
          status: (status as string | null), carrier: opStr(input, "carrier") || null,
          incoterm: opStr(input, "incoterm") || null, orderValue: amount || null,
          currency: opStr(input, "currency") || null,
        },
        successMessage: `Commande logistique ${product} créée.`,
        link: "/logistics", revalidate: ["/logistics"],
      };
    },
    execute: (args) => runFd2(createLogistics, args, "La création de la commande a été refusée.", { revalidate: ["/logistics"] }),
  },

  update_shipment_status: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const order = await resolveShipment(opStr(input, "reference") || opStr(input, "product"));
      if ("error" in order) return order;
      const status = statusIn(opStr(input, "status"), LOGISTICS_STATUS_FR);
      if (status && typeof status === "object") return status;
      const jalons = fieldsOf([
        ["Départ réel", isoDate(opStr(input, "departureDate"))],
        ["Arrivée réelle", isoDate(opStr(input, "arrivalDate"))],
        ["Dédouanement", isoDate(opStr(input, "customsDate"))],
        ["Livraison PCH", isoDate(opStr(input, "deliveryDate"))],
        ["Quantité reçue", opStr(input, "quantity") || null],
      ]);
      if (!status && jalons.length === 0) return { error: "Rien à changer : donnez status (commandé / production / expédié / arrivé au terminal / dédouanement / livré / bloqué) et/ou un jalon daté." };
      return {
        title: `Suivi — ${order.reference} (${order.product})`,
        fields: [
          { label: "Commande", value: `${order.reference} — ${order.product}` },
          ...(status ? [{ label: "Statut", value: `${LOGISTICS_STATUS_FR.find(([c]) => c === order.status)?.[1] ?? order.status} → ${LOGISTICS_STATUS_FR.find(([c]) => c === status)?.[1] ?? status}` }] : []),
          ...jalons,
        ],
        args: {
          id: order.id, status: (status as string | null),
          actualDeparture: isoDate(opStr(input, "departureDate")), actualArrival: isoDate(opStr(input, "arrivalDate")),
          customsDate: isoDate(opStr(input, "customsDate")), pchDeliveryDate: isoDate(opStr(input, "deliveryDate")),
          quantityReceived: opStr(input, "quantity") || null,
        },
        successMessage: `Commande ${order.reference} mise à jour.`,
        link: "/logistics", revalidate: ["/logistics"],
      };
    },
    execute: (args) => runFd(updateLogisticsStatus, args, "La mise à jour du suivi a été refusée.", { revalidate: ["/logistics"] }),
  },
};
