/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN PROCESSUS QUI TOUCHE À UN CHANTIER — et qu'on peut TUER (lot C1, décision 0041, `chantiers/processus.test.ts`).
 *
 *   MODE=reserver   attend `DEPART_MS` (horloge murale) puis tente `reserver(MISSION_ID, RESSOURCES)` ; écrit
 *                   « RESULTAT {json} ». Deux processus lancés ensemble sur la même ressource : un seul gagne.
 *   MODE=conduire   conduit le chantier `MISSION_ID` avec des PORTS FACTICES (aucun réseau) à l'horloge `HORLOGE_MS`.
 *                   `POUSSE=<sha>` : la branche porte déjà ce commit (vert) — ce qu'une session aurait poussé pendant
 *                   la coupure. `SONDE=<cle>` : le processus se FIGE avant cette étape (écrit « BLOQUE <cle> ») — le
 *                   banc l'abat par SIGKILL. Chaque appel à Claude Code est inscrit dans `JOURNAL` (une ligne JSON).
 *
 *   npx tsx scripts/bench/chantier-processus.ts
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import { reserver, type DemandeReservation } from "@/lib/missions/chantiers/reservations";
import { conduireChantier } from "@/lib/missions/chantiers/conduite";
import { REGLAGES_CHANTIERS_DEFAUT } from "@/lib/missions/chantiers/regles";
import { fauxPortsDev } from "@/lib/missions/chantiers/faux-test-outils";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";

const env = (k: string, d = "") => process.env[k] ?? d;
const MISSION = env("MISSION_ID");
const noter = (o: Record<string, unknown>) => { if (env("JOURNAL")) fs.appendFileSync(env("JOURNAL"), `${JSON.stringify({ ...o, pid: process.pid })}\n`); };
const PAS_SUSPENDU: LecteurInterrupteur = async () => ({ suspendues: false, depuis: null, parId: null } as Awaited<ReturnType<LecteurInterrupteur>>);

async function main(): Promise<void> {
  if (env("MODE") === "reserver") {
    const depart = Number(env("DEPART_MS", "0"));
    while (Date.now() < depart) await new Promise((r) => setTimeout(r, 2));
    const r = await reserver(MISSION, JSON.parse(env("RESSOURCES", "[]")) as DemandeReservation[]);
    console.log(`RESULTAT ${JSON.stringify(r)}`);
    return;
  }
  const t0 = Number(env("HORLOGE_MS", String(Date.now())));
  const debutReel = Date.now();
  const clock = { now: () => new Date(t0 + (Date.now() - debutReel)) };
  const ports = fauxPortsDev({ surSession: (n) => { noter({ quoi: "session", n }); return null; } });
  const pousse = env("POUSSE");
  if (pousse) ports.pousser(env("BRANCHE"), pousse, "vert");
  const sonde = env("SONDE");
  const b = await conduireChantier(MISSION, {
    ports, clock, reglages: REGLAGES_CHANTIERS_DEFAUT, interrupteur: PAS_SUSPENDU, vagues: 20,
    cerveau: { disponibles: () => ({ mimo: false, terra: false, sol: false }), executer: async () => ({ ok: false, erreur: "aucun modèle au banc" }) },
    sondes: {
      avantEtape: async (cle) => {
        noter({ quoi: "etape", cle });
        if (sonde && cle === sonde) { console.log(`BLOQUE ${cle}`); await new Promise<never>(() => undefined); }
      },
    },
  });
  console.log(`FIN ${JSON.stringify(b)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
