document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    button = form.querySelector('button'),
    error = document.querySelector('#error');
  button.disabled = true;
  error.textContent = '';
  try {
    const data = Object.fromEntries(new FormData(form));
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sign-in failed.');
    form.reset();
    location.assign('/workspace');
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});
