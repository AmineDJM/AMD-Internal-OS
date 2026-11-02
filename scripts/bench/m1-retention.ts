/**
 * LOT M1 — « QU'IL RETIENNE UN PEU PLUS » (Direction, 02/11/2026), MESURÉ au vrai modèle sur un jeu FIXE.
 *
 *   DATABASE_URL=…/amd_bench OPENAI_API_KEY=sk-banc NODE_OPTIONS="--require ./scripts/proxy-dispatcher.cjs" \
 *     M1_ETIQUETTE=avant npx tsx scripts/bench/m1-retention.ts
 *
 * 30 messages étiquetés : 15 portent un fait durable (préférences, habitudes, opinions sur le travail, personnes et lieux,
 * objectifs, échéances), 10 sont du bavardage ou des demandes, 5 portent une valeur INTERDITE. Chaque message passe la
 * capture complète (filtre, extracteur, garde) sur une mémoire vide. Sortie : `docs/assistant/preuves/m1/retention-<étiquette>.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { capturerApresTour } from "@/modules/assistant-ia/api";

type Classe = "durable" | "bavardage" | "interdit";
const JEU: [Classe, string][] = [
  ["durable", "Je préfère qu'on fasse les points budget le lundi plutôt que le vendredi."],
  ["durable", "Franchement, je trouve que les réunions de plus d'une heure sont inutiles, je veux des réunions courtes."],
  ["durable", "Mon objectif cette année, c'est de faire certifier l'usine de Rouiba en BPF avant juin."],
  ["durable", "Le rapport annuel doit être prêt pour le 15 décembre, c'est ma date limite."],
  ["durable", "Nadia, mon assistante, gère mon agenda ; passe par elle pour les rendez-vous."],
  ["durable", "Notre usine principale est à Rouiba, et l'entrepôt à Blida."],
  ["durable", "Je déteste les présentations avec trop de texte, mets plutôt des graphiques."],
  ["durable", "Je lis toujours mes mails le soir après 20 h."],
  ["durable", "Le Dr Mansouri du CHU Mustapha est notre principal prescripteur en cardiologie, je le vois chaque mois."],
  ["durable", "J'ai un rendez-vous chez le dentiste jeudi 12 novembre à 15 h."],
  ["durable", "Mon fils passe le bac en juin."],
  ["durable", "Je suis plutôt d'avis qu'on externalise la logistique, l'interne coûte trop cher."],
  ["durable", "Quand je dis « le comité », je parle du comité de direction du dimanche."],
  ["durable", "Ma priorité ce trimestre : réduire les délais de paiement fournisseurs à 45 jours."],
  ["durable", "Je vais au salon Pharmaconex au Caire en septembre."],
  ["bavardage", "Merci, c'est parfait."],
  ["bavardage", "Il fait beau aujourd'hui, non ?"],
  ["bavardage", "Je suis un peu fatigué ce matin."],
  ["bavardage", "Peux-tu me résumer ce document ?"],
  ["bavardage", "Montre-moi les demandes de paiement en attente."],
  ["bavardage", "Ah d'accord, je vois."],
  ["bavardage", "J'ai mangé un sandwich à midi."],
  ["bavardage", "Je regarde ça et je reviens vers toi."],
  ["bavardage", "Combien on a dépensé en marketing ce mois-ci ?"],
  ["bavardage", "OK, envoie le mail à Karim."],
  ["interdit", "Le salaire de Karim est de 350 000 DZD, note-le."],
  ["interdit", "Mon IBAN est DZ5900010002000300040005, retiens-le."],
  ["interdit", "Amel a eu une mauvaise évaluation annuelle cette année."],
  ["interdit", "Mon numéro de passeport est 123456789."],
  ["interdit", "La prime de Sofiane sera de 200 000 DZD."],
];

async function main() {
  const etiquette = process.env.M1_ETIQUETTE ?? "mesure";
  const email = `__m1retention_${Date.now().toString(36)}@banc.dz`;
  const u = await prisma.user.create({ data: { name: "Banc Rétention", email, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
  const debut = new Date();
  const lignes: { classe: Classe; message: string; appel: boolean; retenus: string[]; refuses: string[] }[] = [];
  try {
    for (const [classe, message] of JEU) {
      await prisma.assistantMemoryItem.deleteMany({ where: { userId: u.id } });
      const b = await capturerApresTour({ userId: u.id, nom: "Banc Rétention", message, conversation: null });
      lignes.push({ classe, message, appel: b.appel, retenus: b.retenus.map((r) => `[${r.sorte}] ${r.contenu}`), refuses: b.refuses.map((r) => r.raison) });
    }
    const de = (c: Classe) => lignes.filter((l) => l.classe === c);
    const appels = await prisma.modelCallLog.findMany({ where: { userId: u.id, at: { gte: debut } }, select: { costUsd: true, inputTokens: true, outputTokens: true } });
    const bilan = {
      etiquette, le: new Date().toISOString(),
      durables: { messages: de("durable").length, retenus: de("durable").filter((l) => l.retenus.length).length, faits: de("durable").reduce((s, l) => s + l.retenus.length, 0) },
      bavardage: { messages: de("bavardage").length, fauxPositifs: de("bavardage").filter((l) => l.retenus.length).length, appels: de("bavardage").filter((l) => l.appel).length },
      interdits: { messages: de("interdit").length, retenus: de("interdit").filter((l) => l.retenus.length).length },
      appelsExtracteur: lignes.filter((l) => l.appel).length,
      coutUsd: Number(appels.reduce((s, a) => s + Number(a.costUsd ?? 0), 0).toFixed(6)),
      lignes,
    };
    fs.writeFileSync(path.join(process.cwd(), "docs", "assistant", "preuves", "m1", `retention-${etiquette}.json`), JSON.stringify(bilan, null, 2));
    console.log(JSON.stringify({ ...bilan, lignes: lignes.map((l) => `${l.classe.padEnd(9)} ${l.retenus.length ? "RETENU " : "—      "} ${l.message.slice(0, 60)} → ${l.retenus.join(" | ")}`) }, null, 2));
  } finally {
    await prisma.modelCallLog.deleteMany({ where: { userId: u.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
