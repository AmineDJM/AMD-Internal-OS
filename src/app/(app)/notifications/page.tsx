import { requireModule } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { clauseNotificationsOuvrables } from "@/lib/notifications/admission";
import { PageHeader } from "@/components/shared/page-header";
import { EnablePushButton } from "@/components/layout/push-activer";
import { NotificationsList, type NotificationItem } from "./notifications-list";

export default async function NotificationsPage() {
  const user = await requireModule("NOTIFICATIONS");

  // Celles qu'elle peut encore ouvrir : un droit retiré depuis les retire de la liste, sans les effacer (25/11/2026).
  const notifications = await prisma.notification.findMany({
    where: { AND: [{ userId: user.id }, clauseNotificationsOuvrables(user)] },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const items: NotificationItem[] = notifications.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    isRead: n.isRead,
    createdAt: n.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-5">
      <PageHeader title="Notifications" description="Échéances, validations, retards et assignations qui vous concernent.">
        <EnablePushButton />
      </PageHeader>
      <NotificationsList items={items} />
    </div>
  );
}
