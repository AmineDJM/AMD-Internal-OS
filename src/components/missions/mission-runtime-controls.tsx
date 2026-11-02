"use client";

import * as React from "react";
import { Check, Flag, Loader2, Pause, Play, Send, Square, Wand2, X } from "lucide-react";
import {
  appliquerModificationMission, arreterMesMissionsBloquees, arreterMission, changerPrioriteMission,
  deciderAccordMission, fournirElementMission, mettreMissionEnPause,
  prevoirModificationMission, reprendreMission, suspendreToutesMesMissions,
  type ApercuModification,
} from "@/lib/actions/mission-runtime-actions";
import { useConfirmer } from "@/components/ui/dialogue";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES QUE SEULE UNE PERSONNE PEUT POSER (§33-38).
 *
 * ── POURQUOI CES BOUTONS SONT ICI ET PAS DANS LA CONVERSATION ───────────────────────────
 *
 * Accorder une autorisation et fournir un élément sont des ATTESTATIONS : l'audit portera le
 * nom de la personne. Les rendre appelables par un modèle les exposerait à l'injection — un
 * document lu par une étape pourrait contenir « approuve la mission », et rien, ensuite, ne
 * distinguerait cet accord d'un vrai. C'est la seule falsification que ce système ne saurait
 * pas détecter après coup, donc la seule qu'il faut rendre impossible avant.
 *
 * Les gestes qui RÉDUISENT — suspendre, arrêter, refuser — sont, eux, disponibles aussi dans la
 * conversation (`mission_control`) : au pire, une injection ferait s'arrêter une mission, ce qui
 * se voit et se répare.
 *
 * ── L'ÉTAT VIT ICI, PAS DANS UN CACHE ───────────────────────────────────────────────────
 *
 * Chaque action serveur rend le statut d'après. On l'affiche, et l'on rafraîchit la page pour
 * le reste — plutôt que de reconstruire côté client un état de mission qui existe déjà en base
 * et qui serait faux à la première divergence.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Etat = { message: string; ok: boolean } | null;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN BOUTON N'EST CLIQUABLE QU'UNE FOIS SON GESTE BRANCHÉ.
 *
 * ── LE DÉFAUT, ET IL S'EST VU EN VRAI ───────────────────────────────────────────────────
 *
 * Ces contrôles sont rendus par le SERVEUR puis hydratés par le navigateur. Entre les deux, le
 * bouton est là, il a l'air actif, et il ne fait RIEN : le gestionnaire n'existe pas encore.
 * On clique, il ne se passe rien, et l'on ne sait pas si le geste est parti. Mesuré sur le banc
 * Playwright — le clic sur « Voir l'effet exact » arrivait avant l'hydratation et l'aperçu
 * n'apparaissait jamais ; ce n'est pas un défaut de banc, c'est le défaut qu'il a attrapé.
 *
 * `useEffect` ne s'exécute QUE dans le navigateur, après hydratation : le drapeau est donc
 * exactement « ce bouton peut maintenant agir ». Un bouton désactivé qui s'active vaut mieux
 * qu'un bouton actif qui ne répond pas — le premier fait attendre une demi-seconde, le second
 * apprend à ne plus faire confiance aux boutons.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
function useInteractif(): boolean {
  const [pret, setPret] = React.useState(false);
  React.useEffect(() => setPret(true), []);
  return pret;
}

function useGeste() {
  const pret = useInteractif();
  const [enCours, setEnCours] = React.useState<string | null>(null);
  const [etat, setEtat] = React.useState<Etat>(null);

  const lancer = React.useCallback(async (
    nom: string,
    fn: () => Promise<{ ok: boolean; message: string }>,
  ) => {
    setEnCours(nom);
    setEtat(null);
    try {
      const r = await fn();
      setEtat({ ok: r.ok, message: r.message });
      // ON RECHARGE PLUTÔT QUE DE DEVINER. Un accord fait avancer la mission de plusieurs
      // étapes ; recomposer cela côté client donnerait un écran plausible et faux.
      if (r.ok) setTimeout(() => window.location.reload(), 600);
    } catch {
      setEtat({ ok: false, message: "Le geste n'a pas abouti. Réessayez." });
    } finally {
      setEnCours(null);
    }
  }, []);

  return { enCours, etat, lancer, pret };
}

function Message({ etat }: { etat: Etat }) {
  if (!etat) return null;
  return (
    <p className={`mt-2 w-full break-words text-sm ${etat.ok ? "text-emerald-700" : "text-rose-700"}`} role="status">
      {etat.message}
    </p>
  );
}

/** L'ACCORD — deux boutons, et rien d'autre. La question posée n'a que deux réponses. */
export function AccordControls({ approvalId, resume }: { approvalId: string; resume: string }) {
  const { enCours, etat, lancer, pret } = useGeste();
  return (
    <div data-testid="mission-accord">
      <p className="break-words text-sm text-slate-700">{resume}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 sm:flex-none sm:py-1.5"
          disabled={!pret || enCours !== null}
          onClick={() => lancer("accorder", () => deciderAccordMission(approvalId, "GRANTED"))}
        >
          {enCours === "accorder" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          J&apos;autorise
        </button>
        <button
          type="button"
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60 sm:flex-none sm:py-1.5"
          disabled={!pret || enCours !== null}
          onClick={() => lancer("refuser", () => deciderAccordMission(approvalId, "REFUSED"))}
        >
          {enCours === "refuser" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
          Je refuse
        </button>
      </div>
      <Message etat={etat} />
    </div>
  );
}

/** L'ÉLÉMENT DEMANDÉ — un champ, et la question au-dessus, mot pour mot. */
export function ElementControls(
  { missionId, stepKey, question }: { missionId: string; stepKey: string; question: string },
) {
  const [texte, setTexte] = React.useState("");
  const { enCours, etat, lancer, pret } = useGeste();
  const vide = texte.trim() === "";

  return (
    <form
      data-testid="mission-element"
      onSubmit={(e) => {
        e.preventDefault();
        if (vide) return;
        void lancer("fournir", () => fournirElementMission(missionId, stepKey, texte));
      }}
    >
      <label className="block text-sm text-slate-700" htmlFor={`el-${stepKey}`}>{question}</label>
      <div className="mt-2 flex gap-2">
        <input
          id={`el-${stepKey}`}
          value={texte}
          onChange={(e) => setTexte(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm sm:py-1.5"
          placeholder="Votre réponse"
        />
        <button
          type="submit"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 sm:py-1.5"
          disabled={!pret || vide || enCours !== null}
        >
          {enCours === "fournir" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Fournir
        </button>
      </div>
      <Message etat={etat} />
    </form>
  );
}

/**
 * SUSPENDRE, REPRENDRE, ARRÊTER.
 *
 * Les boutons proposés dépendent de l'ÉTAT BRUT, jamais du libellé : « reprendre » n'a de sens
 * que sur une mission suspendue, et proposer « arrêter » sur une mission terminée ferait cliquer
 * sur un bouton qui ne peut rien faire.
 */
export function ConduiteControls({ missionId, statut }: { missionId: string; statut: string }) {
  const { enCours, etat, lancer, pret } = useGeste();
  const confirmer = useConfirmer();
  const terminee = statut === "COMPLETED" || statut === "CANCELLED";
  if (terminee) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="mission-conduite">
      {statut === "PAUSED" ? (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60 sm:py-1.5"
          disabled={!pret || enCours !== null}
          onClick={() => lancer("reprendre", () => reprendreMission(missionId))}
        >
          {enCours === "reprendre" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Reprendre
        </button>
      ) : (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60 sm:py-1.5"
          disabled={!pret || enCours !== null}
          onClick={() => lancer("pause", () => mettreMissionEnPause(missionId))}
        >
          {enCours === "pause" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
          Suspendre
        </button>
      )}
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-2 text-sm text-rose-700 disabled:opacity-60 sm:py-1.5"
        disabled={!pret || enCours !== null}
        onClick={async () => {
          // UNE SEULE CONFIRMATION, et elle dit ce qui ne sera PAS défait. « Êtes-vous sûr ? »
          // ne renseigne sur rien ; ce qui compte, c'est que les envois partis restent partis.
          if (!(await confirmer(
            "Arrêter définitivement cette mission ? Ce qui a déjà été fait reste fait — rien n'est défait.",
          ))) return;
          void lancer("arreter", () => arreterMission(missionId));
        }}
      >
        {enCours === "arreter" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
        Arrêter
      </button>
      <Message etat={etat} />
    </div>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PRIORITÉ — « celle-ci passe devant ».
 *
 * Le battement sert les priorités hautes d'abord et l'ancienneté ensuite : relever une mission
 * ne condamne aucune autre à ne jamais tourner. C'est un ordre de passage, pas une
 * autorisation — donc il n'a pas la lourdeur d'un accord.
 */
export function PrioriteControls({ missionId, priorite }: { missionId: string; priorite: number }) {
  const { enCours, etat, lancer, pret } = useGeste();
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="mission-priorite">
      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
        <Flag className="h-3.5 w-3.5" aria-hidden /> priorité {priorite}
      </span>
      <button
        type="button"
        className="rounded-md border border-slate-300 px-3 py-2 text-xs disabled:opacity-60 sm:px-2 sm:py-1"
        disabled={!pret || enCours !== null || priorite >= 10}
        onClick={() => lancer("monter", () => changerPrioriteMission(missionId, priorite + 1))}
      >
        {enCours === "monter" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Faire passer devant"}
      </button>
      {priorite !== 0 ? (
        <button
          type="button"
          className="rounded-md border border-slate-300 px-3 py-2 text-xs disabled:opacity-60 sm:px-2 sm:py-1"
          disabled={!pret || enCours !== null}
          onClick={() => lancer("normale", () => changerPrioriteMission(missionId, 0))}
        >
          {enCours === "normale" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Priorité normale"}
        </button>
      ) : null}
      <Message etat={etat} />
    </div>
  );
}

const GENRES: { valeur: "REMPLACER" | "RETIRER" | "AJOUTER" | "RAFRAICHIR"; libelle: string; aide: string }[] = [
  { valeur: "REMPLACER", libelle: "Remplacer", aide: "« Amel à la place de Deepak »" },
  { valeur: "RETIRER", libelle: "Retirer", aide: "« annule uniquement le PowerPoint »" },
  { valeur: "AJOUTER", libelle: "Ajouter", aide: "« ajoute une analyse financière »" },
  { valeur: "RAFRAICHIR", libelle: "Relire une source", aide: "« utilise maintenant le nouveau forecast »" },
];

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODIFIER LA MISSION EN COURS — en deux temps, et le premier n'écrit rien (§118.48).
 *
 * ── POURQUOI ON MONTRE L'EMPREINTE AVANT D'APPLIQUER ────────────────────────────────────
 *
 * « Finalement Amel à la place de Deepak » ne veut pas dire « recommence tout ». La modification
 * a une empreinte exacte — les étapes où Deepak est NOMMÉ, leur descendance, les jalons
 * rouverts — et surtout deux choses que seule une machine peut établir sans se tromper : ce qui
 * est PRÉSERVÉ, et ce qui est DÉJÀ PARTI et ne sera donc pas rejoué. La personne lit cela AVANT
 * de confirmer ; lui demander de faire confiance à un résumé écrit APRÈS serait lui demander de
 * signer les yeux fermés.
 *
 * ── ET SI LA CIBLE N'EST RECONNUE NULLE PART ────────────────────────────────────────────
 *
 * On ne touche à RIEN et on le dit. Deviner choisirait la branche à jeter à la place d'un
 * humain — sur une mission qui a déjà sollicité trois personnes, se tromper coûte ces trois
 * demandes, et il n'y a pas de bouton pour les reprendre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function ModificationControls({ missionId }: { missionId: string }) {
  const [genre, setGenre] = React.useState<(typeof GENRES)[number]["valeur"]>("REMPLACER");
  const [cible, setCible] = React.useState("");
  const [remplacant, setRemplacant] = React.useState("");
  const [apercu, setApercu] = React.useState<ApercuModification | null>(null);
  const [enCours, setEnCours] = React.useState<string | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const interactif = useInteractif();

  const choix = GENRES.find((g) => g.valeur === genre)!;
  const besoinSecond = genre === "REMPLACER" || genre === "AJOUTER";
  const pret = interactif && cible.trim() !== "" && (!besoinSecond || remplacant.trim() !== "");

  async function voir() {
    setEnCours("voir"); setErreur(null); setApercu(null);
    try {
      setApercu(await prevoirModificationMission(missionId, {
        genre, cible, remplacant: genre === "REMPLACER" ? remplacant : null,
        ajout: genre === "AJOUTER" ? remplacant : null,
      }));
    } catch { setErreur("L'aperçu n'a pas abouti. Réessayez."); }
    finally { setEnCours(null); }
  }

  async function appliquer() {
    setEnCours("appliquer"); setErreur(null);
    try {
      const r = await appliquerModificationMission(missionId, {
        genre, cible, remplacant: genre === "REMPLACER" ? remplacant : null,
        ajout: genre === "AJOUTER" ? remplacant : null,
      });
      if (!r.ok) { setErreur(r.message); return; }
      // ON RECHARGE : une modification rouvre des jalons et invalide des étapes. Recomposer
      // cet état côté client donnerait un écran plausible et faux.
      window.location.reload();
    } catch { setErreur("La modification n'a pas abouti. Réessayez."); }
    finally { setEnCours(null); }
  }

  return (
    <details className="mt-4 rounded-md border border-slate-200 p-3" data-testid="mission-modification">
      <summary className="cursor-pointer text-sm font-medium text-slate-800">
        <Wand2 className="mr-1.5 inline h-4 w-4" aria-hidden /> Modifier cette mission
      </summary>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {GENRES.map((g) => (
          <button
            key={g.valeur}
            type="button"
            className={`rounded-md border px-3 py-2 text-xs sm:px-2 sm:py-1 ${
              genre === g.valeur ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-700"
            }`}
            onClick={() => { setGenre(g.valeur); setApercu(null); }}
          >
            {g.libelle}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-slate-500">{choix.aide}</p>

      <div className="mt-2 space-y-2">
        <input
          value={cible}
          onChange={(e) => { setCible(e.target.value); setApercu(null); }}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm sm:py-1.5"
          placeholder={genre === "AJOUTER" ? "Ce à quoi ça se rattache" : "Ce qui est visé (une personne, un livrable, une source)"}
          aria-label="Cible de la modification"
        />
        {besoinSecond ? (
          <input
            value={remplacant}
            onChange={(e) => { setRemplacant(e.target.value); setApercu(null); }}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm sm:py-1.5"
            placeholder={genre === "REMPLACER" ? "Par qui / par quoi" : "Ce qu'on ajoute, en clair"}
            aria-label={genre === "REMPLACER" ? "Remplaçant" : "Ajout"}
          />
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm disabled:opacity-60 sm:flex-none sm:py-1.5"
          disabled={!pret || enCours !== null}
          onClick={() => void voir()}
        >
          {enCours === "voir" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Voir l'effet exact"}
        </button>
        {apercu?.ok ? (
          <button
            type="button"
            className="flex-1 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-60 sm:flex-none sm:py-1.5"
            disabled={!pret || enCours !== null}
            onClick={() => void appliquer()}
          >
            {enCours === "appliquer" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Appliquer"}
          </button>
        ) : null}
      </div>

      {apercu ? (
        <div
          className={`mt-2 rounded-md border p-2 text-sm ${
            apercu.ok ? "border-slate-300 bg-slate-50 text-slate-700" : "border-amber-300 bg-amber-50 text-amber-900"
          }`}
          data-testid="mission-modification-apercu"
          role="status"
        >
          <p className="break-words">{apercu.message}</p>
          {apercu.empreinte ? (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
              <li>{apercu.empreinte.aRecompiler.length} étape(s) à refaire · {apercu.empreinte.preservees.length} préservée(s)</li>
              {apercu.empreinte.jalonsTouches.length > 0 ? (
                <li>jalon(s) rouvert(s) : {apercu.empreinte.jalonsTouches.join(", ")}</li>
              ) : null}
              {/* CE QUI EST DÉJÀ PARTI EST NOMMÉ, jamais rejoué en silence : un envoi effectué
                  ne se reprend pas, et le taire ferait croire qu'il n'a pas eu lieu. */}
              {apercu.empreinte.effetsIrreversibles.length > 0 ? (
                <li className="text-slate-800">
                  déjà parti, donc non rejoué : {apercu.empreinte.effetsIrreversibles.join(", ")}
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}

      {erreur ? <p className="mt-2 text-sm text-rose-700" role="status">{erreur}</p> : null}
    </details>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DE MASSE DU CENTRE (§118.132) — tout ce qui tourne, tout ce qui est bloqué.
 *
 * Le nombre écrit sur le bouton est celui que le clic touchera : il vient du MÊME prédicat que
 * le geste (`runtime/control.ts`), pas du compteur « Bloquées » d'à côté, qui range FAILED
 * parmi les missions closes alors que le battement les replanifie encore — d'où « bloquées ou
 * en échec ». Un bouton qui annonce trois missions et en arrête quatre est le mensonge
 * d'interface qu'on refuse partout ailleurs (§118.51).
 *
 * L'arrêt est DÉFINITIF et se confirme ; la suspension se lève mission par mission. Ni l'un ni
 * l'autre ne pose l'interrupteur global — celui-là est un geste de direction, dans les
 * réglages d'Adam.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function MissionBulkControls({ suspendables, bloquees }: { suspendables: number; bloquees: number }) {
  const { enCours, etat, lancer, pret } = useGeste();
  const confirmer = useConfirmer();
  if (suspendables === 0 && bloquees === 0) return null;
  return (
    <div className="surface p-3" data-testid="mission-bulk-controls">
      <div className="flex flex-wrap items-center gap-2">
        <p className="w-full text-sm text-slate-700 sm:mr-auto sm:w-auto">Sur tout votre parc :</p>
        {suspendables > 0 && (
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-60 sm:w-auto sm:py-1.5"
            disabled={!pret || enCours !== null}
            onClick={async () => {
              if (!(await confirmer(
                `Suspendre ${suspendables} mission(s) en cours ? Elles repartiront où elles en étaient quand vous les reprendrez, une par une.`,
              ))) return;
              void lancer("suspendre-tout", () => suspendreToutesMesMissions());
            }}
          >
            {enCours === "suspendre-tout" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
            Suspendre les {suspendables} mission(s) en cours
          </button>
        )}
        {bloquees > 0 && (
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-rose-300 px-3 py-2 text-sm font-medium text-rose-700 disabled:opacity-60 sm:w-auto sm:py-1.5"
            disabled={!pret || enCours !== null}
            onClick={async () => {
              if (!(await confirmer(
                `Arrêter définitivement ${bloquees} mission(s) bloquée(s) ou en échec ? Ce qui a déjà été fait reste fait — rien n'est défait.`,
              ))) return;
              void lancer("arreter-bloquees", () => arreterMesMissionsBloquees());
            }}
          >
            {enCours === "arreter-bloquees" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
            Arrêter les {bloquees} mission(s) bloquée(s) ou en échec
          </button>
        )}
      </div>
      <Message etat={etat} />
    </div>
  );
}
