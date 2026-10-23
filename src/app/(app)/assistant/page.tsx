import { notFound } from "next/navigation";
import Link from "next/link";
import { Sparkles, ArrowRight } from "lucide-react";
import { requireModule } from "@/lib/session";
import { peutVoirAdam } from "@/platform/in-process/visibilite-adam";
import { aiConfigured, sttConfigured, cleModeleRequise } from "@/lib/ai";
import { phraseIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { featureEnabled, FEATURES } from "@/lib/features";
import { getDailyBrief } from "@/lib/daily-brief";
import { MorningBrief } from "@/components/shared/morning-brief";
import { AssistantChat } from "./assistant-chat";

export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const user = await requireModule("WORKSPACE");
  // Adam n'est visible que du Super Admin (§118.153) — la même page qu'une adresse inconnue.
  if (!peutVoirAdam(user)) notFound();
  // Mémoire personnelle et point du matin : indisponibles en « Vue exacte » — la mémoire
  // d'une personne ne s'ouvre à personne d'autre, pas même à un administrateur.
  const [memoryEnabled, proactive] = await Promise.all([
    user.impersonatedBy ? Promise.resolve(false) : featureEnabled(FEATURES.ASSISTANT_MEMORY.key, user.id),
    user.impersonatedBy ? Promise.resolve(false) : featureEnabled(FEATURES.ASSISTANT_PROACTIVE.key, user.id),
  ]);
  const brief = proactive ? await getDailyBrief(user).catch(() => null) : null;
  return (
    // PLEIN ÉCRAN : l'assistant prend toute la hauteur disponible, comme une application de
    // discussion. Les marges du conteneur principal sont neutralisées pour que le rail des
    // conversations touche le bord — c'est ce qui fait la différence avec « une page ».
    //
    // `app-viewport-flush` s'arrête au RAS de la barre d'onglets (hauteurs mesurées, cf.
    // chrome-metrics.tsx). La hauteur était auparavant écrite en dur — le champ de saisie
    // se retrouvait derrière la barre sur téléphone.
    <div className="app-viewport-flush -mx-3 -mt-3 flex flex-col gap-3 px-2 pt-2 sm:-mx-4 sm:-mt-6 sm:px-3 sm:pt-4 lg:-mx-8 lg:px-6">
      {/* Bannière de transition vers le nouvel Assistant IA Beta (Xiaomi MiMo + Apple Glassmorphism) */}
      <div className="rounded-2xl border border-sky-300/80 bg-gradient-to-r from-sky-50 via-white to-indigo-50/80 p-3.5 text-slate-800 shadow-sm dark:border-sky-700/60 dark:bg-gradient-to-r dark:from-slate-900/90 dark:via-slate-900 dark:to-indigo-950/80 dark:text-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white shadow-md">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm">✨ Nouvel Assistant IA (Beta) disponible</span>
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[0.6875rem] font-bold text-sky-700 dark:bg-sky-900/60 dark:text-sky-300 border border-sky-200 dark:border-sky-800">
                Xiaomi MiMo Flash + Apple Design
              </span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
              Accédez au nouvel environnement de travail avec décor Makoto Shinkai, curseur luminescent dynamique et modèle Xiaomi MiMo configuré.
            </p>
          </div>
        </div>
        <Link
          href="/assistant/beta"
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-xs font-semibold text-white shadow-sm transition active:scale-95"
        >
          Ouvrir l'Assistant Beta
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      {brief?.text && <MorningBrief initial={brief.text} />}
      <AssistantChat
        userName={user.name}
        configured={aiConfigured()}
        messageIaNonConfiguree={phraseIaNonConfiguree(cleModeleRequise(), "l'assistant")}
        voiceConfigured={sttConfigured()}
        memoryEnabled={memoryEnabled}
      />
    </div>
  );
}
