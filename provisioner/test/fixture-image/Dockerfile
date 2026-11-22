# Fixture image for the real-Docker tests: tagged <test registry>/selfbase-{db,core,job}:test by the tests.
# It only idles; the job tag runs /scripts/backup.sh.
FROM node:24.22.2-slim
COPY backup.sh /scripts/backup.sh
# a Windows checkout may carry CRLF
RUN sed -i 's/\r$//' /scripts/backup.sh
CMD ["sleep", "infinity"]
