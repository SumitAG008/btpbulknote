using btpbulknote as db from '../db/schema';

service NotificationsService {
  entity NotificationConfigs as projection on db.NotificationConfigs;
  entity NotificationRuns as projection on db.NotificationRuns;
  entity EmployeeNotificationLogs as projection on db.EmployeeNotificationLogs;

  action runDaily(runDate : Date, dryRun : Boolean) returns NotificationRuns;
}
