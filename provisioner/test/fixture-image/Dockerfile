# Fixture image for the real-Docker tests: tagged <test registry>/selfbase-{db,core,job}:test by the tests.
# Services run idle.sh (marks a clean SIGTERM stop); the job tag runs /scripts/backup.sh.
FROM node:24.22.2-slim
COPY backup.sh idle.sh /scripts/
# a Windows checkout may carry CRLF
RUN sed -i 's/\r$//' /scripts/backup.sh /scripts/idle.sh
CMD ["bash", "/scripts/idle.sh"]
