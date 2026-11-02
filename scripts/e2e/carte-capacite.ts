/**
 * LE DÉCOR DU FORMULAIRE DE CARTE POUR L'E2E (J11, décision 0030) — sous `tsx`, avec le code de PRODUCTION.
 *
 *   seed <email>    prépare, comme le ferait l'assistant, une carte `task__createTask` (titre, responsable désigné par son
 *                   nom, échéance) par l'outil de capacité réel (`outilsV1`), et la pose dans le fil de la personne
 *                   (un message, une réponse portant la carte et son formulaire généré depuis le contrat) ;
 *   clean <email>   retire les tâches, intentions et tours semés.
 *
 * Aucun appel de modèle : c'est la règle de la suite E2E.
 */

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { outilsV1, type PropositionPreparee } from "@/modules/assistant-ia/api";

const TITRE = "__e2e__ Préparer le stand du congrès";

async function personne(email: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: null, access, mustChangePassword: false } as CurrentUser;
}

async function main(): Promise<void> {
  const [cmd, email] = process.argv.slice(2);
  if (!email) throw new Error("usage : carte-capacite.ts seed|clean <email>");
  const user = await personne(email);
  await prisma.task.deleteMany({ where: { title: { startsWith: "__e2e__" }, createdById: user.id } });
  await prisma.assistantActionIntent.deleteMany({ where: { userId: user.id, title: "Créer tâche" } });
  await prisma.assistantIaTour.deleteMany({ where: { userId: user.id, contenu: { contains: "__e2e__" } } });
  if (cmd !== "seed") return;

  const props: PropositionPreparee[] = [];
  const outil = outilsV1(user, props, [], [], null, undefined, { capacites: true }).find((t) => t.def.name === "task__createTask");
  if (!outil) throw new Error("capacité task__createTask absente");
  const sortie = await outil.run({ title: TITRE, assignedToId: user.name, dueDate: "2026-11-06", description: "Kakémono, présentoir et échantillons." }, user);
  const p = props[0];
  if (!p) throw new Error(`aucune carte : ${sortie}`);
  // Décision 0027 : plusieurs conversations par personne — l'écran ouvre la COURANTE (la plus récente, ni archivée ni
  // privée) ; la carte du banc y est posée et la conversation remonte en tête.
  const courante = await prisma.assistantIaFil.findFirst({ where: { userId: user.id, archiveLe: null, prive: false }, orderBy: { dernierLe: "desc" } });
  const fil = courante
    ? await prisma.assistantIaFil.update({ where: { id: courante.id }, data: { dernierLe: new Date() } })
    : await prisma.assistantIaFil.create({ data: { userId: user.id } });
  const question = await prisma.assistantIaTour.create({
    data: { filId: fil.id, userId: user.id, role: "user", contenu: "__e2e__ Crée une tâche : préparer le stand du congrès pour le 6 novembre.", etat: "TRAITE" },
  });
  await prisma.assistantIaTour.create({
    data: {
      filId: fil.id, userId: user.id, role: "assistant", etat: "TERMINE", repondA: question.id,
      contenu: "__e2e__ Voici la tâche préparée : vérifiez les champs, corrigez au besoin, puis signez.",
      intent: { id: p.intentId, kind: p.proposition.kind, title: p.proposition.title, fields: p.proposition.fields, warnings: p.proposition.warnings, formulaire: p.proposition.formulaire, status: "PROPOSED" } as object,
    },
  });
  console.log(p.intentId);
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
