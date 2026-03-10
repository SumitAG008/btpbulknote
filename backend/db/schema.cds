namespace btpbulknote;

using { cuid, managed } from '@sap/cds/common';

entity NotificationConfigs : cuid, managed {
  eventType       : String(30);
  locale          : String(10);
  legalEntity     : String(50);
  active          : Boolean default true;
  fromEmail       : String(255);
  subjectTemplate : String(255);
  bodyTemplate    : LargeString;
}

entity NotificationRuns : cuid, managed {
  runAt          : Timestamp;
  runType        : String(30);
  totalProcessed : Integer;
  totalSent      : Integer;
  totalFailed    : Integer;
}

entity EmployeeNotificationLogs : cuid, managed {
  employeeId      : String(50);
  email           : String(255);
  fullName        : String(255);
  eventType       : String(30);
  milestoneYears  : Integer;
  eventDate       : Date;
  sentAt          : Timestamp;
  status          : String(20);
  errorDetails    : LargeString;
  providerRef     : String(255);
}
