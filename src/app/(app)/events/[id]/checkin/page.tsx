import Link from "next/link";
import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { CheckinConfirm } from "./checkin-confirm";

export const dynamic = "force-dynamic";

export default async function CheckinPage(
  props: { params: Promise<{ id: string }>; searchParams: Promise<{ token?: string }> }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  await requireModule("EVENTS", "UPDATE");
  const token = searchParams.token ?? null;
  const reg = token
    ? await prisma.eventRegistration.findUnique({ where: { qrToken: token }, select: { firstName: true, lastName: true, eventId: true } })
    : null;

  return (
    <div className="mx-auto max-w-md space-y-5">
      <PageHeader title="Check-in" description="Scan du badge participant." />
      {!reg || reg.eventId !== params.id ? (
        <div className="surface p-6 text-center text-base text-muted-foreground sm:text-sm">
          QR invalide ou participant introuvable.
          <div className="mt-4"><Link href={`/events/${params.id}`} className="inline-flex h-12 w-full items-center justify-center rounded-lg border border-border px-4 font-medium text-primary transition-colors hover:bg-secondary sm:h-10 sm:w-auto">Retour à l'événement</Link></div>
        </div>
      ) : (
        <CheckinConfirm token={token!} name={`${reg.firstName} ${reg.lastName}`} eventId={params.id} />
      )}
    </div>
  );
}
