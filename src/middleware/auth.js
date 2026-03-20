/**
 * JWT Authentication Middleware
 * Validates Bearer token and attaches user to request
 */
export async function authenticate(request, reply) {
  try {
    const decoded = await request.jwtVerify();
    request.user = decoded;
  } catch (err) {
    reply.status(401).send({
      success: false,
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
  }
}
