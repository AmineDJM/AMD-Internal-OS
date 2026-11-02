import type { Metadata, Viewport } from "next";
import Image from "next/image";
import { LoginForm } from "./login-form";
import { MODE_ADVENTUM_IA } from "@/platform/app-mode";
import { METADONNEES_ADVENTUM_IA } from "@/app/ia/metadonnees";

// Le même build sert l'ERP et Adventum IA : la page lit son mode au moment de la requête.
export const dynamic = "force-dynamic";

const modeApp = () => process.env.APP_MODE === MODE_ADVENTUM_IA;

export function generateViewport(): Viewport {
  return modeApp()
    ? { width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false, viewportFit: "cover", interactiveWidget: "resizes-content", themeColor: "#2c59a7" }
    : { width: "device-width", initialScale: 1, viewportFit: "cover" };
}

export function generateMetadata(): Metadata {
  return modeApp() ? { ...METADONNEES_ADVENTUM_IA, title: "Connexion — Adventum IA" } : { title: "Connexion — AMD Internal OS" };
}

/**
 * ADVENTUM IA (`APP_MODE=adventum-ia`) — la connexion porte le nom, le logo et le bleu de l'app (charte Adventum) :
 * mêmes comptes que l'ERP, mais la personne sait où elle entre. L'ERP garde sa page, inchangée.
 */
function ConnexionAdventumIa() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#f5f8fc] px-6 dark:bg-[#08111f]">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <Image src="/adventum-ia/logo-marque.png" alt="" width={64} height={64} priority />
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-[#2c59a7] dark:text-[#7fa6e3]">Adventum IA</h1>
            <p className="text-sm text-muted-foreground">L&apos;assistant d&apos;Adventum Pharma — connectez-vous avec votre compte habituel.</p>
          </div>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}

export default function LoginPage() {
  if (modeApp()) return <ConnexionAdventumIa />;
  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <div className="relative hidden w-1/2 flex-col justify-between bg-sidebar p-12 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sidebar-accent text-lg font-bold text-sidebar">
            A
          </div>
          <div>
            <p className="text-base font-semibold">AMD Internal OS</p>
            <p className="text-xs text-sidebar-muted">Adventum Pharma</p>
          </div>
        </div>

        <div className="max-w-md space-y-4">
          <h1 className="text-3xl font-semibold leading-tight">
            Le système d&apos;exploitation interne d&apos;Adventum.
          </h1>
          <p className="text-sm leading-relaxed text-sidebar-muted">
            Regulatory, Sponsoring, Budgets, Congrès, Ventes, Logistique PCH,
            Promotion médicale et Business Development — centralisés, sécurisés
            et pilotés en temps réel.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3 text-xs text-sidebar-muted">
          <div className="rounded-lg border border-white/10 p-3">
            <p className="text-lg font-semibold text-white">8</p>
            pôles métiers
          </div>
          <div className="rounded-lg border border-white/10 p-3">
            <p className="text-lg font-semibold text-white">RBAC</p>
            accès par ligne
          </div>
          <div className="rounded-lg border border-white/10 p-3">
            <p className="text-lg font-semibold text-white">100%</p>
            traçabilité
          </div>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex w-full flex-col items-center justify-center px-6 lg:w-1/2">
        <div className="w-full max-w-sm space-y-8">
          <div className="space-y-1.5 lg:hidden">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
                A
              </div>
              <span className="font-semibold">AMD Internal OS</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Connexion</h2>
            <p className="text-sm text-muted-foreground">
              Accédez à votre espace de travail Adventum.
            </p>
          </div>

          <LoginForm />
        </div>
      </div>
    </div>
  );
}
