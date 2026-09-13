FROM python:3.12-slim

RUN useradd -m -u 1000 user
WORKDIR /home/user/app

COPY --chown=user filebeam.py .

USER user
ENV HOME=/home/user PATH="/home/user/.local/bin:$PATH"

EXPOSE 7860

CMD ["python", "filebeam.py", "--port", "7860", "--max", "1"]
