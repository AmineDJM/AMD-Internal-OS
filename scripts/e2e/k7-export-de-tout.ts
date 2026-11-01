/**
 * K7 SUITE (décision 0037 § 7) POUR L'E2E AU FAUX MODÈLE — sous `tsx`, avec le code de PRODUCTION du fil et des outils,
 * dans le GESTE de la personne (une lecture R0 de l'ERP exige sa session).
 *
 *   paiements <email> <message>   le modèle appelle `exporter_demandes_paiement`, puis répond avec le lien de téléchargement ;
 *   medecins  <email> <message>   le modèle trouve la lecture (`trouver_outil`), LIT l'annuaire (`chercherMedecinsAnnuaire`, « Blida »), puis `exporter_donnees`
 *                                 en PDF sur ce jeu du tour, puis répond avec le lien.
 * L'écran n'en sait rien que par sa relecture (`/api/assistant-ia/fil`), comme en vrai. Pour quand le vrai modèle n'est
 * pas joignable (crédit épuisé) : le passage réel est `scripts/bench/k7-export-de-tout.ts`.
 */
import { prisma } from "@/lib/prisma";
import { executerHorsRequete, personneDuGeste } from "@/lib/contexte-geste";
import { deposerMessage, traiterFil } from "@/modules/assistant-ia/api";
import { modeleFactice, remplacerModelesPourTests } from "@/modules/assistant-ia/api-banc";

const LECTURE_ANNUAIRE = "ad-pro-medecins__chercherMedecinsAnnuaire";
// Le DERNIER fichier du prompt : celui que l'outil vient de rendre (l'historique cite les fichiers des tours précédents).
const nodeId = (prompt: string) => [...prompt.replace(/\\\//g, "/").matchAll(/\/api\/drive\/(c[a-z0-9]{20,})\/raw/g)].at(-1)?.[1] ?? "";
const reponse = (quoi: string) => (p: string) => ({ texte: JSON.stringify({ message: `${quoi} : [Télécharger](/api/drive/${nodeId(p)}/raw?dl=1).`, components: [] }) });

async function main(): Promise<void> {
  const [cas, email, message] = process.argv.slice(2);
  if (!cas || !email || !message) throw new Error("usage : k7-export-de-tout.ts paiements|medecins <email> <message>");
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const user = (await personneDuGeste(u.id))!;
  const f = modeleFactice(cas === "paiements"
    ? [{ appel: { outil: "exporter_demandes_paiement", entree: {} } }, reponse("Les demandes de paiement sont exportées en Excel")]
    : [
      // La lecture de l'annuaire n'est pas offerte d'office : le modèle la TROUVE d'abord, comme le vrai.
      { appel: { outil: "trouver_outil", entree: { intention: "chercher des médecins dans l'annuaire" } } },
      { appel: { outil: LECTURE_ANNUAIRE, entree: { q: "Blida" } } },
      { appel: { outil: "exporter_donnees", entree: { source: LECTURE_ANNUAIRE, format: "pdf", titre: "Médecins de Blida" } } },
      reponse("La liste des médecins de Blida est exportée en PDF"),
    ]);
  remplacerModelesPourTests([f.modele as never]);
  const { resultat: conversation } = await executerHorsRequete(user, "essai", async () => {
    const d = await deposerMessage(u.id, message, []);
    if (!d.ok) throw new Error(d.erreur);
    await traiterFil(u.id, d.conversation);
    return d.conversation;
  });
  // La conversation où le message est déposé : l'écran l'ouvre (`/ia?c=…`).
  if (process.env.K7_DEBUG) console.error(JSON.stringify(f.promptsRecus.at(-1) ?? "").slice(-2500));
  process.stdout.write(JSON.stringify({ conversation, tours: f.toursJoues() }));
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
