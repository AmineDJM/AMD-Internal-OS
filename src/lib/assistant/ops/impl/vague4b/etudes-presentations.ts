/**
 * OPS VAGUE 4b — ÉTUDES DE MARCHÉ (lignes, acteurs, pré-remplissage marché) et PRÉSENTATIONS IA
 * versionnées, par les actions canoniques du Business Development.
 */
import { prisma } from "./erp";
import { createMarketResearch, updateMarketResearch, setMarketResearchParticipants, deleteMarketResearch, addResearchRow, updateResearchRow, deleteResearchRow, addResearchPlayer, updateResearchPlayer, deleteResearchPlayer, prefillResearchRow } from "@/lib/actions/market-research-actions";
import { generatePresentation, regeneratePresentation, renamePresentation, deletePresentation } from "@/lib/actions/market-presentation-actions";
import type { OpImpl, OpProposalDraft } from "../../types";
import { opStr } from "../../types";
import { runFd, runFd2, fieldsOf, resolveOne } from "../../helpers";
import { fold } from "../../impl-regulatory";
import { resolvePerson } from "./commun";

const resolveResearch = (raw: string) =>
  resolveOne(raw, "l'étude de marché (champ « research » — son titre)",
    (q) => prisma.marketResearch.findMany({ where: { title: { contains: q, mode: "insensitive" } }, select: { id: true, title: true }, orderBy: { createdAt: "desc" }, take: 6 }),
    (r) => r.title);

const resolvePresentation = (raw: string) =>
  resolveOne(raw, "la présentation (champ « presentation » — son titre)",
    (q) => prisma.marketResearchPresentation.findMany({ where: { title: { contains: q, mode: "insensitive" } }, select: { id: true, title: true, researchId: true }, orderBy: { updatedAt: "desc" }, take: 6 }),
    (p) => p.title);

async function resolveResearchRow(researchId: string, researchTitle: string, raw: string) {
  const rows = await prisma.marketResearchRow.findMany({
    where: { researchId }, select: { id: true, product: true }, orderBy: { sortOrder: "asc" }, take: 40,
  });
  if (rows.length === 0) return { error: `L'étude « ${researchTitle} » n'a aucune ligne.` } as const;
  const q = fold(raw);
  if (!q) {
    if (rows.length === 1) return rows[0];
    return { error: `Précisez la ligne (champ « row ») parmi : ${rows.slice(0, 12).map((r) => r.product).join(" ; ")}.` } as const;
  }
  const hits = rows.filter((r) => fold(r.product).includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `Aucune ligne « ${raw} » dans « ${researchTitle} » — lignes : ${rows.slice(0, 12).map((r) => r.product).join(" ; ")}.` } as const;
  return { error: `Plusieurs lignes correspondent : ${hits.map((r) => r.product).join(" ; ")} — préciser.` } as const;
}

async function resolvePlayer(rowId: string, rowLabel: string, raw: string) {
  const players = await prisma.marketResearchPlayer.findMany({
    where: { rowId }, select: { id: true, name: true, rank: true }, orderBy: { rank: "asc" }, take: 20,
  });
  if (players.length === 0) return { error: `La ligne « ${rowLabel} » n'a aucun acteur.` } as const;
  const q = fold(raw);
  if (!q) {
    if (players.length === 1) return players[0];
    return { error: `Précisez l'acteur (champ « player ») parmi : ${players.map((p) => p.name).join(" ; ")}.` } as const;
  }
  const hits = players.filter((p) => fold(p.name).includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return { error: `Aucun acteur « ${raw} » sur « ${rowLabel} » — acteurs : ${players.map((p) => p.name).join(" ; ")}.` } as const;
  return { error: `Plusieurs acteurs correspondent : ${hits.map((p) => p.name).join(" ; ")} — préciser.` } as const;
}

// ─────────────────────────── ÉTUDES DE MARCHÉ & PRÉSENTATIONS ───────────────────────────

const RESEARCH_REVALIDATE = ["/business-development/etudes"];

export const BD4_OPS_IMPL: Record<string, OpImpl> = {
  create_research: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "research") || opStr(input, "name");
      if (!title) return { error: "Précisez le titre de l'étude (champ « research »)." };
      const molecules = opStr(input, "molecules").split(/[;,\n]/).map((m) => m.trim()).filter(Boolean);
      return {
        title: `Nouvelle étude de marché « ${title} »`,
        fields: fieldsOf([
          ["Étude", title],
          ["Molécules initiales", molecules.length ? molecules.join(", ") : null],
          ["Notes", opStr(input, "notes") || null],
        ]),
        args: { title, molecules: molecules.join("\n") || null, notes: opStr(input, "notes") || null },
        successMessage: `Étude « ${title} » créée${molecules.length ? ` (${molecules.length} molécule·s)` : ""}.`,
        link: "/business-development/etudes", revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd2(createMarketResearch, args, "La création de l'étude a été refusée.", { revalidate: RESEARCH_REVALIDATE }),
  },

  update_research: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const research = await resolveResearch(opStr(input, "research") || opStr(input, "name"));
      if ("error" in research) return research;
      const current = await prisma.marketResearch.findUnique({ where: { id: research.id }, select: { notes: true, sources: true } });
      const statusRaw = fold(opStr(input, "status"));
      const status = /final|termin/.test(statusRaw) ? "FINAL" : /brouillon|draft/.test(statusRaw) ? "DRAFT" : null;
      const newName = opStr(input, "newName");
      if (!newName && !status && !opStr(input, "notes") && !opStr(input, "sources")) {
        return { error: "Rien à changer : donnez newName, status (brouillon / finale), notes ou sources." };
      }
      // FUSION : notes et sources sont REMPLACÉES par l'action — l'existant est rejoué.
      return {
        title: `Modifier l'étude « ${research.title} »`,
        fields: fieldsOf([
          ["Étude", newName ? `${research.title} → ${newName}` : research.title],
          ["Statut", status ? (status === "FINAL" ? "Finale" : "Brouillon") : null],
        ]),
        args: {
          id: research.id, title: newName || null, status,
          notes: opStr(input, "notes") || current?.notes || null,
          sources: opStr(input, "sources") || current?.sources || null,
        },
        successMessage: `Étude « ${newName || research.title} » mise à jour.`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd(updateMarketResearch, args, "La modification de l'étude a été refusée.", { revalidate: RESEARCH_REVALIDATE }),
  },

  set_research_participants: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const research = await resolveResearch(opStr(input, "research") || opStr(input, "name"));
      if ("error" in research) return research;
      const raw = opStr(input, "people");
      const clearing = /^(aucune?|personne|vide)$/i.test(raw);
      const ids: string[] = []; const names: string[] = [];
      if (!clearing && raw) {
        for (const part of raw.split(/[;,]/).map((p) => p.trim()).filter(Boolean)) {
          const person = await resolvePerson(part, "le participant (champ « people »)");
          if ("error" in person) return person;
          ids.push(person.id); names.push(person.name);
        }
      }
      if (!clearing && ids.length === 0) return { error: "Donnez les participants (champ « people », virgules) — ou « aucun » pour vider la liste." };
      return {
        title: `Participants de « ${research.title} »`,
        fields: [
          { label: "Étude", value: research.title },
          { label: "Participants", value: clearing ? "— (liste vidée)" : names.join(", ") },
        ],
        warnings: ["La liste REMPLACE la précédente."],
        args: { id: research.id, participantIds: ids.join(",") },
        successMessage: clearing ? "Participants retirés." : `${names.length} participant(s) sur « ${research.title} ».`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    async execute(args) {
      const fd = new FormData();
      fd.set("id", args.id ?? "");
      for (const id of (args.participantIds ?? "").split(",").filter(Boolean)) fd.append("participantIds", id);
      const r = await setMarketResearchParticipants(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Le réglage des participants a été refusé." };
      return { ok: true, revalidate: RESEARCH_REVALIDATE };
    },
  },

  delete_research: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const research = await resolveResearch(opStr(input, "research") || opStr(input, "name"));
      if ("error" in research) return research;
      const [rows, presentations] = await Promise.all([
        prisma.marketResearchRow.count({ where: { researchId: research.id } }),
        prisma.marketResearchPresentation.count({ where: { researchId: research.id } }),
      ]);
      return {
        title: `SUPPRIMER l'étude « ${research.title} »`,
        fields: [
          { label: "Étude", value: research.title },
          { label: "Emporte avec elle", value: `${rows} ligne(s), leurs acteurs, ${presentations} présentation(s)` },
        ],
        warnings: ["Suppression définitive EN CASCADE : lignes, acteurs et présentations IA disparaissent avec l'étude."],
        confirmText: research.title,
        args: { id: research.id },
        successMessage: `Étude « ${research.title} » supprimée (cascade comprise).`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd(deleteMarketResearch, args, "La suppression de l'étude a été refusée.", { revalidate: RESEARCH_REVALIDATE }),
  },

  add_research_row: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const research = await resolveResearch(opStr(input, "research") || opStr(input, "name"));
      if ("error" in research) return research;
      const product = opStr(input, "row") || opStr(input, "products");
      if (!product) return { error: "Précisez le produit / la molécule (champ « row »)." };
      return {
        title: `Ajouter « ${product} » à l'étude « ${research.title} »`,
        fields: [{ label: "Étude", value: research.title }, { label: "Produit", value: product }],
        args: { researchId: research.id, product },
        successMessage: `Ligne « ${product} » ajoutée à « ${research.title} ».`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd(addResearchRow, args, "L'ajout de la ligne a été refusé.", { revalidate: RESEARCH_REVALIDATE }),
  },

  update_research_row: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const research = await resolveResearch(opStr(input, "research") || opStr(input, "name"));
      if ("error" in research) return research;
      const hit = await resolveResearchRow(research.id, research.title, opStr(input, "row"));
      if ("error" in hit) return hit;
      const row = await prisma.marketResearchRow.findUnique({ where: { id: hit.id } });
      if (!row) return { error: "Ligne introuvable." };
      const changes: string[] = [];
      const num = (key: string, current: unknown, label: string): string | null => {
        const v = opStr(input, key);
        if (v) { changes.push(label); return v; }
        return current == null ? null : String(Number(current));
      };
      const therapeuticClass = opStr(input, "therapeuticClass") ? (changes.push("classe"), opStr(input, "therapeuticClass")) : row.therapeuticClass;
      const product = opStr(input, "newName") ? (changes.push("produit"), opStr(input, "newName")) : row.product;
      const marketVolume = num("quantity", row.marketVolume, "volume marché");
      const marketValueUsd = num("amount", row.marketValueUsd, "valeur marché (USD)");
      const avgPrice = num("price", row.avgPricePerBoxUsd, "prix moyen / boîte");
      const comment = opStr(input, "notes") ? (changes.push("commentaire"), opStr(input, "notes")) : row.comment;
      if (changes.length === 0) return { error: "Rien à changer : donnez newName, therapeuticClass, quantity (volume), amount (valeur USD), price ou notes." };
      return {
        title: `Modifier la ligne « ${row.product} » (${research.title})`,
        fields: [
          { label: "Ligne", value: `${row.product} — ${research.title}` },
          { label: "Modifications", value: changes.join(" · ") },
          { label: "Le reste", value: "rejoué à l'identique" },
        ],
        args: { id: hit.id, researchId: research.id, therapeuticClass, product, marketVolume, marketValueUsd, avgPricePerBoxUsd: avgPrice, comment },
        successMessage: `Ligne « ${product} » mise à jour (${changes.join(", ")}).`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd(updateResearchRow, args, "La modification de la ligne a été refusée.", { revalidate: RESEARCH_REVALIDATE }),
  },

  delete_research_row: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const research = await resolveResearch(opStr(input, "research") || opStr(input, "name"));
      if ("error" in research) return research;
      const hit = await resolveResearchRow(research.id, research.title, opStr(input, "row"));
      if ("error" in hit) return hit;
      return {
        title: `Retirer « ${hit.product} » de l'étude « ${research.title} »`,
        fields: [{ label: "Ligne", value: `${hit.product} — ${research.title}` }],
        warnings: ["La ligne et ses acteurs disparaissent — l'étude reste."],
        args: { id: hit.id, researchId: research.id },
        successMessage: `Ligne « ${hit.product} » retirée.`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd(deleteResearchRow, args, "Le retrait de la ligne a été refusé.", { revalidate: RESEARCH_REVALIDATE }),
  },

  add_research_player: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const research = await resolveResearch(opStr(input, "research") || opStr(input, "name"));
      if ("error" in research) return research;
      const hit = await resolveResearchRow(research.id, research.title, opStr(input, "row"));
      if ("error" in hit) return hit;
      const name = opStr(input, "player");
      if (!name) return { error: "Précisez le nom de l'acteur (champ « player » — laboratoire)." };
      return {
        title: `Ajouter l'acteur « ${name} » sur « ${hit.product} »`,
        fields: [{ label: "Ligne", value: `${hit.product} — ${research.title}` }, { label: "Acteur", value: name }],
        args: { rowId: hit.id, researchId: research.id, name },
        successMessage: `Acteur « ${name} » ajouté sur « ${hit.product} ».`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd(addResearchPlayer, args, "L'ajout de l'acteur a été refusé.", { revalidate: RESEARCH_REVALIDATE }),
  },

  update_research_player: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const research = await resolveResearch(opStr(input, "research") || opStr(input, "name"));
      if ("error" in research) return research;
      const hit = await resolveResearchRow(research.id, research.title, opStr(input, "row"));
      if ("error" in hit) return hit;
      const player = await resolvePlayer(hit.id, hit.product, opStr(input, "player"));
      if ("error" in player) return player;
      const current = await prisma.marketResearchPlayer.findUnique({ where: { id: player.id }, select: { marketShareValue: true, status: true } });
      const statusRaw = fold(opStr(input, "mode"));
      const status = /import/.test(statusRaw) ? "IMPORT" : /fabri|local|manufact/.test(statusRaw) ? "MANUFACTURING" : null;
      const share = opStr(input, "amount");
      const newName = opStr(input, "newName");
      if (!newName && !share && !status) return { error: "Rien à changer : donnez newName, amount (part de marché) ou mode (importation / fabrication)." };
      // FUSION : part et statut sont REMPLACÉS par l'action — l'existant est rejoué.
      return {
        title: `Modifier l'acteur « ${player.name} » (${hit.product})`,
        fields: fieldsOf([
          ["Acteur", newName ? `${player.name} → ${newName}` : player.name],
          ["Part de marché", share || (current?.marketShareValue != null ? String(Number(current.marketShareValue)) : null)],
          ["Origine", status ? (status === "IMPORT" ? "Importation" : "Fabrication locale") : null],
        ]),
        args: {
          id: player.id, researchId: research.id, name: newName || null,
          marketShareValue: share || (current?.marketShareValue != null ? String(Number(current.marketShareValue)) : null),
          status: status ?? current?.status ?? null,
        },
        successMessage: `Acteur « ${newName || player.name} » mis à jour.`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd(updateResearchPlayer, args, "La modification de l'acteur a été refusée.", { revalidate: RESEARCH_REVALIDATE }),
  },

  delete_research_player: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const research = await resolveResearch(opStr(input, "research") || opStr(input, "name"));
      if ("error" in research) return research;
      const hit = await resolveResearchRow(research.id, research.title, opStr(input, "row"));
      if ("error" in hit) return hit;
      const player = await resolvePlayer(hit.id, hit.product, opStr(input, "player"));
      if ("error" in player) return player;
      return {
        title: `Retirer l'acteur « ${player.name} » de « ${hit.product} »`,
        fields: [{ label: "Acteur", value: `${player.name} — ${hit.product}` }],
        args: { id: player.id, researchId: research.id },
        successMessage: `Acteur « ${player.name} » retiré.`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd(deleteResearchPlayer, args, "Le retrait de l'acteur a été refusé.", { revalidate: RESEARCH_REVALIDATE }),
  },

  prefill_research_row: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const research = await resolveResearch(opStr(input, "research") || opStr(input, "name"));
      if ("error" in research) return research;
      const hit = await resolveResearchRow(research.id, research.title, opStr(input, "row"));
      if ("error" in hit) return hit;
      return {
        title: `Pré-remplir « ${hit.product} » depuis l'intelligence marché`,
        fields: [{ label: "Ligne", value: `${hit.product} — ${research.title}` }],
        warnings: ["Apports : marché (volume / valeur), prix moyen, et les acteurs détectés (fabricants / importateurs) — les acteurs ne sont ajoutés QUE si la ligne n'en a pas encore."],
        args: { id: hit.id, researchId: research.id },
        successMessage: `Ligne « ${hit.product} » pré-remplie depuis l'intelligence marché.`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd(prefillResearchRow, args, "Le pré-remplissage a été refusé.", { revalidate: RESEARCH_REVALIDATE }),
  },

  generate_presentation: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const research = await resolveResearch(opStr(input, "research") || opStr(input, "name"));
      if ("error" in research) return research;
      return {
        title: `Générer une présentation IA de « ${research.title} »`,
        fields: fieldsOf([
          ["Étude", research.title],
          ["Titre de la présentation", opStr(input, "presentation") || `${research.title} — Présentation (défaut)`],
          ["Consigne", opStr(input, "notes") || null],
        ]),
        warnings: ["Analyse IA ancrée sur TOUTE l'étude (v1 stockée comme source de vérité) — le .pptx se reconstruit à la demande au téléchargement."],
        args: { researchId: research.id, title: opStr(input, "presentation") || null, instruction: opStr(input, "notes") || null },
        successMessage: `Présentation IA de « ${research.title} » générée (v1).`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd2(generatePresentation, args, "La génération de la présentation a été refusée.", { revalidate: RESEARCH_REVALIDATE }),
  },

  regenerate_presentation: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const presentation = await resolvePresentation(opStr(input, "presentation") || opStr(input, "name"));
      if ("error" in presentation) return presentation;
      const instruction = opStr(input, "notes");
      if (!instruction) return { error: "Donnez la consigne de réorientation (champ « notes ») — c'est elle qui justifie une nouvelle version." };
      return {
        title: `Relancer « ${presentation.title} » avec consigne`,
        fields: [
          { label: "Présentation", value: presentation.title },
          { label: "Consigne", value: instruction },
        ],
        warnings: ["Une NOUVELLE VERSION historisée est créée — les précédentes restent consultables."],
        args: { presentationId: presentation.id, instruction },
        successMessage: `Nouvelle version de « ${presentation.title} » générée.`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd2(regeneratePresentation, args, "La relance de la présentation a été refusée.", { revalidate: RESEARCH_REVALIDATE }),
  },

  rename_presentation: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const presentation = await resolvePresentation(opStr(input, "presentation") || opStr(input, "name"));
      if ("error" in presentation) return presentation;
      const newName = opStr(input, "newName");
      if (!newName) return { error: "Précisez le nouveau titre (champ « newName »)." };
      return {
        title: `Renommer « ${presentation.title} » → « ${newName} »`,
        fields: [{ label: "Présentation", value: `${presentation.title} → ${newName}` }],
        args: { id: presentation.id, title: newName },
        successMessage: `Présentation renommée « ${newName} ».`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd(renamePresentation, args, "Le renommage a été refusé.", { revalidate: RESEARCH_REVALIDATE }),
  },

  delete_presentation: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const presentation = await resolvePresentation(opStr(input, "presentation") || opStr(input, "name"));
      if ("error" in presentation) return presentation;
      const versions = await prisma.marketResearchPresentationVersion.count({ where: { presentationId: presentation.id } });
      return {
        title: `Supprimer la présentation « ${presentation.title} »`,
        fields: [{ label: "Présentation", value: presentation.title }, { label: "Versions emportées", value: String(versions) }],
        warnings: ["Toutes les versions historisées disparaissent — l'étude, elle, reste (une nouvelle présentation peut être régénérée)."],
        args: { id: presentation.id },
        successMessage: `Présentation « ${presentation.title} » supprimée.`,
        revalidate: RESEARCH_REVALIDATE,
      };
    },
    execute: (args) => runFd(deletePresentation, args, "La suppression de la présentation a été refusée.", { revalidate: RESEARCH_REVALIDATE }),
  },
};
