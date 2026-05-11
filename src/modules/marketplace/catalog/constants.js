const DEFAULT_SERVICE_CATEGORY = 'Uncategorized';
const OPERATIONAL_BARBER_ROLES = ['barber', 'super-barber'];

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Наличные' },
  { value: 'card', label: 'Карта' },
  { value: 'certificate', label: 'Сертификат' },
];

const ACTIVE_QUEUE_STATUSES = ['waiting', 'called', 'swapped', 'in_progress'];

module.exports = {
  DEFAULT_SERVICE_CATEGORY,
  OPERATIONAL_BARBER_ROLES,
  PAYMENT_METHODS,
  ACTIVE_QUEUE_STATUSES,
};
