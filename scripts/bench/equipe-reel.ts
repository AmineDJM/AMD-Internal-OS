/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC RÉEL DE L'ÉQUIPE (lot O2, décision 0059 § 9) — PRÊT, NON LANCÉ. Il coûte (sessions Claude Code sur
 * l'abonnement de la Direction, minutes de CI GitHub) : il ne part qu'avec le feu vert explicite (`EQUIPE_BANC_FEU_VERT=1`).
 *
 * Ce qu'il prouve EN RÉEL (et que les tests, ports factices, ne peuvent pas prouver) : trois sessions Claude Code cloud
 * lancées en parallèle par les Routines ou le relais, leurs commits vus par GitHub, la CI de `claude/integration/**`
 * déclenchée par le push, l'avance fast-forward d'une branche cible par l'API GitHub, le tout réveillé par les webhooks.
 *
 * Garde-fous : un DÉPÔT DE BANC dédié (`EQUIPE_BANC_DEPOT=proprietaire/nom`, jamais l'ERP), une cible `claude/banc-…`
 * (jamais main), Super Admin désigné (`EQUIPE_BANC_SUPER_ADMIN`), aucun service Render (un programme ne déploie pas).
 * Prérequis : `GITHUB_TOKEN` (contents + pull-requests + checks + actions sur le dépôt de banc), une routine
 * `CLAUDE_ROUTINE_<ALIAS>_ID/_TOKEN` pour ce dépôt OU le relais connecté, la base de l'ERP (le worker Render).
 *
 *   EQUIPE_BANC_FEU_VERT=1 EQUIPE_BANC_DEPOT=aminedjm/banc-equipe EQUIPE_BANC_SUPER_ADMIN=<id> npx tsx scripts/bench/equipe-reel.ts
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { lancerProgramme, ouEnEstProgramme } from "@/lib/missions/equipe/service";

async function main(): Promise<void> {
  if (process.env.EQUIPE_BANC_FEU_VERT !== "1") throw new Error("banc réel NON lancé : feu vert requis (EQUIPE_BANC_FEU_VERT=1) — il consomme l'abonnement et la CI");
  const [proprietaire, nom] = (process.env.EQUIPE_BANC_DEPOT ?? "").split("/");
  if (!proprietaire || !nom || /amd-internal-os/i.test(nom)) throw new Error("EQUIPE_BANC_DEPOT : un dépôt de banc dédié (jamais l'ERP)");
  const admin = process.env.EQUIPE_BANC_SUPER_ADMIN ?? "";
  const cible = `claude/banc-${new Date().toISOString().slice(0, 16).replace(/[^0-9]/g, "")}`;
  const tache = (cle: string) => ({
    cle, titre: `Fichier ${cle}`, objectif: `Créer banc/${cle}.md contenant exactement la ligne « ${cle} ».`, perimetre: [`banc/${cle}.md`],
    criteres: [`banc/${cle}.md existe et contient « ${cle} »`], commandesVerif: [`grep -qx ${cle} banc/${cle}.md`], taille: "S",
  });
  const r = await lancerProgramme(admin, { plan: { titre: "Banc réel de l'équipe", objectif: "Trois tâches indépendantes en parallèle", depot: { proprietaire, nom }, cible, concurrence: 3, budget: { lancements: 6 }, taches: [tache("un"), tache("deux"), tache("trois")] } }, { origine: "banc:equipe-reel" });
  if (!r.ok) throw new Error(`${r.erreur} ${(r.fautes ?? []).join(" ")}`);
  console.log(`PROGRAMME ${r.programmeId} — cible ${cible} (créez-la depuis la branche par défaut du dépôt de banc avant le premier passage). Le battement du worker le conduit ; état :`);
  console.log(JSON.stringify(await ouEnEstProgramme(admin, r.programmeId), null, 1));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
