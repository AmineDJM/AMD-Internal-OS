/**
 * OPS VAGUE 4a — VENTES : saisie et import CSV collé. Par les actions canoniques.
 */
import { createSale, importSales } from "@/lib/actions/sales-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd2, fieldsOf, isoDate, dzd } from "../../helpers";

// ─────────────────────────── VENTES ───────────────────────────

export const SALES_OPS_IMPL: Record<string, OpImpl> = {
  create_sale: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const product = opStr(input, "product") || opStr(input, "name");
      const client = opStr(input, "client");
      if (!product) return { error: "Précisez le produit vendu (champ « product »)." };
      if (!client) return { error: "Précisez le client (champ « client »)." };
      const qty = opStr(input, "quantity");
      const unitPrice = opStr(input, "amount");
      const isService = /service|prestation/i.test(opStr(input, "kind"));
      const isPch = /pch/i.test(opStr(input, "client")) || /oui|pch|true/i.test(opStr(input, "isPch"));
      const revenue = qty && unitPrice ? Number(qty) * Number(unitPrice) : null;
      return {
        title: `Vente — ${product} → ${client}`,
        fields: fieldsOf([
          ["Type", isService ? "Service" : "Produit"],
          ["Produit", product], ["Client", client],
          ["PCH", isPch ? "Oui" : null],
          ["Quantité", qty || null], ["Prix unitaire", unitPrice ? dzd(Number(unitPrice)) : null],
          ["Chiffre d'affaires", revenue != null ? dzd(revenue) : null],
          ["Date", isoDate(opStr(input, "date"))],
          ["DCI", opStr(input, "dci") || null],
        ]),
        args: {
          product, client, saleType: isService ? "SERVICE" : null,
          quantity: qty || null, unitPrice: unitPrice || null,
          date: isoDate(opStr(input, "date")), dci: opStr(input, "dci") || null,
          dosage: opStr(input, "dosage") || null, institution: opStr(input, "institution") || null,
          isPch: isPch ? "1" : null,
        },
        successMessage: `Vente ${product} → ${client} enregistrée.`,
        link: "/sales/historique", revalidate: ["/sales/historique"],
      };
    },
    execute: (args) => runFd2(createSale, args, "L'enregistrement de la vente a été refusé.", { revalidate: ["/sales"] }),
  },

  import_sales: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const csv = opStr(input, "csv") || opStr(input, "text");
      if (!csv) return { error: "Collez le CSV des ventes (champ « csv ») — en-tête : date,produit,dci,dosage,forme,client,institution,pch,quantité,prix unitaire." };
      const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) return { error: "CSV vide : il faut l'en-tête PUIS au moins une ligne de données." };
      return {
        title: `Importer ${lines.length - 1} ligne(s) de ventes (CSV collé)`,
        fields: [
          { label: "Lignes de données", value: String(lines.length - 1) },
          { label: "En-tête lu", value: lines[0].slice(0, 120) },
        ],
        warnings: ["Chaque ligne devient une VENTE réelle — les lignes sans produit ou sans client sont ignorées (le résultat le dira)."],
        args: { csv },
        successMessage: `Ventes importées (${lines.length - 1} ligne(s) traitée(s)).`,
        link: "/sales/historique", revalidate: ["/sales/historique"],
      };
    },
    execute: (args) => runFd2(importSales, args, "L'import des ventes a été refusé.", { revalidate: ["/sales"] }),
  },
};
