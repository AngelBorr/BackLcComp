// Initialize Chart.js with Cordes styling
const ctx = document.getElementById('revenueChart').getContext('2d')
new Chart(ctx, {
  type: 'line',
  data: {
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
    datasets: [
      {
        label: 'Revenue',
        data: [25000, 32000, 28000, 35000, 42000, 48000],
        borderColor: '#1e40af',
        backgroundColor: 'rgba(30, 64, 175, 0.1)',
        borderWidth: 3,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#1e40af',
        pointBorderColor: '#ffffff',
        pointBorderWidth: 2,
        pointRadius: 5
      }
    ]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false
      }
    },
    scales: {
      x: {
        grid: {
          display: false
        },
        ticks: {
          color: '#6b7280'
        }
      },
      y: {
        beginAtZero: true,
        grid: {
          color: '#f3f4f6'
        },
        ticks: {
          color: '#6b7280',
          callback: function (value) {
            return ' + value.toLocaleString()'
          }
        }
      }
    },
    elements: {
      point: {
        hoverRadius: 8
      }
    }
  }
})

// Add some interactive functionality
document.addEventListener('DOMContentLoaded', function () {
  // Sidebar navigation active state
  const navLinks = document.querySelectorAll('nav a')
  navLinks.forEach((link) => {
    link.addEventListener('click', function (e) {
      e.preventDefault()
      navLinks.forEach((l) => l.classList.remove('bg-gray-700', 'text-white'))
      navLinks.forEach((l) => l.classList.add('text-gray-300'))
      this.classList.add('bg-gray-700', 'text-white')
      this.classList.remove('text-gray-300')
    })
  })

  // Set dashboard as active by default
  navLinks[0].classList.add('bg-gray-700', 'text-white')
  navLinks[0].classList.remove('text-gray-300')

  // Notification bell animation
  const bellIcon = document.querySelector('.fa-bell')
  if (bellIcon) {
    setInterval(() => {
      bellIcon.classList.add('animate-pulse')
      setTimeout(() => {
        bellIcon.classList.remove('animate-pulse')
      }, 1000)
    }, 5000)
  }

  // Stats cards hover effects
  const statsCards = document.querySelectorAll('.hover\\:shadow-md')
  statsCards.forEach((card) => {
    card.addEventListener('mouseenter', function () {
      this.style.transform = 'translateY(-2px)'
    })
    card.addEventListener('mouseleave', function () {
      this.style.transform = 'translateY(0)'
    })
  })
})
