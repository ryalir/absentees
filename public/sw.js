self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : { title: 'Attendance Update', body: 'New notification received.' };
  
  const options = {
    body: data.body,
    icon: '/icon.png',
    badge: '/badge.png'
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});
